const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const axios = require("axios");
require("dotenv").config();

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

exports.slackEntry = async (req, res) => {
  const body = req.body;
  const params = new URLSearchParams(body);

  const command = params.get("command")?.toLowerCase();
  const user = params.get("user_name");
  const text = params.get("text");
  const responseUrl = params.get("response_url");

  res.status(200).send();

  if (command === "/report") {
    await handleReportCommand(text, user, responseUrl);
  } else if (command === "/list") {
    await handleListCommand(text, responseUrl);
  } else {
    await postToSlack(responseUrl, "❌ Perintah tidak dikenali.");
  }
};

async function handleReportCommand(text, user, responseUrl) {
  const parts = text.split("|").map(s => s.trim());
  if (parts.length < 3) {
    return postToSlack(responseUrl, "❌ Format salah. Gunakan: /report [project] | [sub-project] | [aktivitas] | [optional: dd/mm/yyyy]");
  }

  const [projectRaw, subProjectRaw, activityRaw, optionalDate] = parts;
  const project = projectRaw.toLowerCase();
  const subProject = subProjectRaw.toLowerCase();
  const activity = activityRaw;

  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });
    const spreadsheetId = process.env.SPREADSHEET_ID;

    // Validasi project dan subproject
    const projectList = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "SheetProject!A2:A100"
    }).then(res => res.data.values.flat().map(p => p.toLowerCase()));

    if (!projectList.includes(project)) {
      return postToSlack(responseUrl, `❌ Project *${project}* tidak ditemukan di SheetProject.`);
    }

    const subProjectList = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `SheetProject_${project}!A2:A100`
    }).then(res => res.data.values.flat().map(p => p.toLowerCase()));

    if (!subProjectList.includes(subProject)) {
      return postToSlack(responseUrl, `❌ *${subProjectRaw}* bukan sub-project dari *${project}*.`);
    }

    // Tanggal yang digunakan
    let dateUsed = new Date();
    if (optionalDate && /^\d{2}\/\d{2}\/\d{4}$/.test(optionalDate)) {
      const [dd, mm, yyyy] = optionalDate.split("/");
      dateUsed = new Date(`${yyyy}-${mm}-${dd}T00:00:00+07:00`);
    }
    if (isNaN(dateUsed.getTime())) {
      return postToSlack(responseUrl, "❌ Format tanggal salah. Gunakan: dd/mm/yyyy");
    }

    const formattedDate = new Date(dateUsed).toLocaleString("en-GB", {
      timeZone: "Asia/Jakarta",
      hour12: false
    }).replace(",", "");

    const sheetName = `Report_${project}`;

    // Ambil data seluruh sheet untuk sheet ini
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A2:F`
    });

    const rows = existing.data.values || [];
    const todayStr = formattedDate.split(" ")[0]; // ex: 09/07/2025

    const userRowsToday = rows
      .map((row, idx) => ({ row, idx })) // untuk update nanti
      .filter(({ row }) => {
        const [rawDate, rowUser] = row;
        const rowDateStr = rawDate.split(" ")[0]; // Ambil hanya tanggal
        return rowUser === user && rowDateStr === todayStr;
      });

    const reportCount = userRowsToday.length + 1;
    const newWeight = +(1.0 / reportCount).toFixed(3); // dibulatkan ke 3 digit

    // Update semua weight sebelumnya
    for (const { idx } of userRowsToday) {
      const rowIndex = idx + 2; // karena range dimulai dari A2
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!E${rowIndex}`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[newWeight]]
        }
      });
    }

    // Tambahkan row baru
    const weekNumber = getWeekOfMonth(dateUsed);
    const newRow = [[
      formattedDate,
      user,
      subProjectRaw,
      activity,
      newWeight,
      weekNumber
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:F`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: newRow }
    });

    await postToSlack(responseUrl, `✅ Terima kasih, report *${subProjectRaw}* berhasil dikirim!`);
  } catch (err) {
    console.error("[ERROR handleReport]", err);
    await postToSlack(responseUrl, "❌ Terjadi kesalahan internal.");
  }
}



async function handleListCommand(text, responseUrl) {
  const project = text.toLowerCase();
  const spreadsheetId = process.env.SPREADSHEET_ID;

  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });

    const subRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `SheetProject_${project}!A2:A100`
    });

    const subProjects = subRes.data.values?.flat() || [];
    if (!subProjects.length) {
      return postToSlack(responseUrl, `📭 Tidak ada sub-project di *${project}*.`);
    }

    const message = `*Daftar Sub-Project dari ${project}:*\n` + subProjects.map(p => `• ${p}`).join("\n");
    await postToSlack(responseUrl, message);
  } catch (err) {
    console.error("[ERROR handleList]", err);
    await postToSlack(responseUrl, "❌ Gagal mengambil daftar project.");
  }
}

function getWeekOfMonth(date) {
  const d = new Date(date);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  return Math.ceil((d.getDate() + first.getDay()) / 7);
}

function formatDateWIB(date) {
  return new Date(date).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

async function postToSlack(url, text) {
  try {
    await axios.post(url, { text });
  } catch (e) {
    console.error("[ERROR postToSlack]", e);
  }
}