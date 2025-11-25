import { App } from "@slack/bolt";
import dotenv from "dotenv";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";

dotenv.config();

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const authClient = await auth.getClient();
const sheets = google.sheets({ version: "v4", auth: authClient });
const spreadsheetId = process.env.SPREADSHEET_ID;
var kuassaProjects = [];
var mixwaveProjects = [];

const project = {
  Kuassa: kuassaProjects,
  MixWave: mixwaveProjects,
};

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

app.command("/report", async ({ ack, body, client }) => {
  await ack();
  const today = new Date().toISOString().split("T")[0];

  await client.views.open({
    trigger_id: body.trigger_id,
    view: makeModal({ date: today }),
  });
});

app.command("/refresh", async ({ ack, body, client }) => {
  await ack();
  kuassaProjects = await getSubProjects("kuassa");
  mixwaveProjects = await getSubProjects("mixwave");
  await client.chat.postMessage({
    channel: body.user_id,
    text: `✅ List has been refreshed`,
  });
});

async function getSubProjects(project) {
  try {
    const sheets = google.sheets({ version: "v4", auth: authClient });
    const subRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `SheetProject_${project}!A2:A100`,
    });

    const subProjects = subRes.data.values?.flat() || [];
    if (!subProjects.length) {
      console.log(`📭 Tidak ada sub-project di *${project}*.`);
      return [];
    }
    return subProjects;
  } catch (err) {
    console.error("[ERROR handleList]", err);
    return [];
  }
}

function makeModal({ date, project, subprojectOptions = [] }) {
  return {
    type: "modal",
    callback_id: "report_submit",
    title: { type: "plain_text", text: "Daily Report" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "date",
        label: { type: "plain_text", text: "Date" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: date,
        },
        optional: false,
      },
      {
        type: "section",
        block_id: "project",
        text: { type: "mrkdwn", text: "*Project*" },
        accessory: {
          type: "radio_buttons",
          action_id: "project_select",
          options: [
            { text: { type: "plain_text", text: "Kuassa" }, value: "kuassa" },
            { text: { type: "plain_text", text: "Mixwave" }, value: "mixwave" },
          ],
        },
      },
      {
        type: "input",
        block_id: "subproject",
        label: { type: "plain_text", text: "Sub Project" },
        element: {
          type: "static_select",
          action_id: "subproject_select",
          placeholder: { type: "plain_text", text: "Select a subproject..." },
          options:
            subprojectOptions.length > 0
              ? subprojectOptions // ✅ use directly, no map
              : [
                  {
                    text: {
                      type: "plain_text",
                      text: "— Please select a project first —",
                    },
                    value: "none",
                  },
                ],
        },
        optional: false,
      },
      {
        type: "input",
        block_id: "do",
        label: { type: "plain_text", text: "Do" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
        },
        optional: false,
      },
      {
        type: "input",
        block_id: "obstacle",
        label: { type: "plain_text", text: "Obstacle" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
        },
        optional: true,
      },
    ],
  };
}

// --- dynamic update when project changes ---
app.action("project_select", async ({ body, ack, client }) => {
  await ack();
  const project = body.actions[0].selected_option.value;
  const date = new Date().toISOString().split("T")[0];
  let subOpts = [];
  if (project == "kuassa") subOpts = kuassaProjects;
  else if (project == "mixwave") subOpts = mixwaveProjects;
  subOpts = subOpts
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .map((s) => {
      const short = s.length > 75 ? s.slice(0, 72) + "..." : s;
      return {
        text: { type: "plain_text", text: short },
        value: s.slice(0, 75), // value also max 75 chars
      };
    });

  await client.views.update({
    view_id: body.view.id,
    hash: body.view.hash,
    view: makeModal({ date, project, subprojectOptions: subOpts }),
  });
});

// --- form submission ---
app.view("report_submit", async ({ ack, body, view, client }) => {
  await ack();

  const user = body.user.name;
  const date = view.state.values.date.value.value;
  const project =
    view.state.values.project.project_select.selected_option.value;
  const subproject =
    view.state.values.subproject.subproject_select.selected_option.value;
  const do_ = view.state.values.do.value.value;
  const obstacle = view.state.values.obstacle.value.value ?? "";

  // save to sheet here (your logic)
  try {
    const projectList = await sheets.spreadsheets.values
      .get({
        spreadsheetId,
        range: "SheetProject!A2:A100",
      })
      .then((res) => res.data.values.flat().map((p) => p.toLowerCase()));

    let dateUsed = new Date();
    if (date && /^\d{4}\-\d{2}\-\d{2}$/.test(date)) {
      const [yyyy, mm, dd] = date.split("-");
      dateUsed = new Date(`${yyyy}-${mm}-${dd}T00:00:00+07:00`);
    }
    if (isNaN(dateUsed.getTime())) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `❌  Wrong date format! use yyyy-mm-dd`,
      });
      return;
    }
    const formattedDate = new Date(dateUsed)
      .toLocaleString("en-GB", {
        timeZone: "Asia/Jakarta",
        hour12: false,
      })
      .replace(",", "");

    const sheetName = `Report_${project}`;
    // Ambil data seluruh sheet untuk sheet ini
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A2:G`,
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
        range: `${sheetName}!F${rowIndex}`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[newWeight]],
        },
      });
    }

    // Tambahkan row baru
    const weekNumber = getWeekOfMonth(dateUsed);
    const newRow = [
      [formattedDate, user, subproject, do_, obstacle, newWeight, weekNumber],
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:G`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: newRow },
    });
    await client.chat.postMessage({
      channel: process.env.SLACK_CHANNEL_ID,
      text: `✅ Report submitted:\n• *Name: ${user}*\n• *Date:* ${date}\n• *Project:* ${project}\n• *Sub Project:* ${subproject}\n• *Do:*\n${do_}\n*Obstacle:*\n${obstacle}`,
    });
  } catch (e) {
    console.log(e);
    // await client.chat.postMessage({
    //   channel: body.user.id,
    //   text: `Something wrong when happen, please report this error:\n\n${e.toString()}`,
    // });
  }
});

function getWeekOfMonth(date) {
  const d = new Date(date);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  return Math.ceil((d.getDate() + first.getDay()) / 7);
}

(async () => {
  kuassaProjects = await getSubProjects("kuassa");
  console.log(kuassaProjects);
  mixwaveProjects = await getSubProjects("mixwave");
  console.log(mixwaveProjects);
  await app.start(process.env.PORT || 3000);
  console.log("⚡ Slackbot running!");
})();
