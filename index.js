import express from 'express';
import dotenv from 'dotenv';
import { GoogleAuth } from 'google-auth-library';
import { google } from 'googleapis';

dotenv.config();

// --- 1. SETUP GOOGLE SHEETS AUTHENTICATION ---
const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

let authClient;
let sheets;
const spreadsheetId = process.env.SPREADSHEET_ID;

var kuassaProjects = [];
var mixwaveProjects = [];

// Inisialisasi Auth
async function initGoogle() {
  authClient = await auth.getClient();
  sheets = google.sheets({ version: "v4", auth: authClient });

  kuassaProjects = await getSubProjects("kuassa");
  console.log("Kuassa Projects Loaded:", kuassaProjects.length);
  mixwaveProjects = await getSubProjects("mixwave");
  console.log("Mixwave Projects Loaded:", mixwaveProjects.length);
}

// --- 2. FUNGSI PEMBANTU ---
async function getSubProjects(project) {
  try {
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
    console.error("[ERROR getSubProjects]", err);
    return [];
  }
}

function getWeekOfMonth(date) {
  const d = new Date(date);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  return Math.ceil((d.getDate() + first.getDay()) / 7);
}

// --- 3. UI GENERATOR: GOOGLE CHAT CARDS V2 ---
// --- 3. UI GENERATOR: GOOGLE CHAT CARDS V2 ---
function makeDialogCard(date, selectedProject, subprojectOptions = []) {
  // Susun opsi dropdown subproject
  let mappedSubOptions = subprojectOptions.length > 0
    ? subprojectOptions.map(s => {
      const short = s.length > 75 ? s.slice(0, 72) + "..." : s;
      return { text: short, value: s.slice(0, 75) };
    })
    : [{ text: "— Please select a project first —", value: "none" }];

  // Build project dropdown items — hanya sertakan "selected: true" jika terpilih
  // Google Chat API TIDAK menerima "selected: false"
  const projectItems = [
    { text: "Kuassa", value: "kuassa" },
    { text: "Mixwave", value: "mixwave" }
  ];
  if (selectedProject) {
    projectItems.forEach(item => {
      if (item.value === selectedProject) {
        item.selected = true;
      }
    });
  }

  return {
    sections: [
      {
        widgets: [
          {
            textInput: {
              name: "date",
              label: "Date (yyyy-mm-dd)",
              value: date
            }
          },
          {
            selectionInput: {
              name: "project",
              label: "Project",
              type: "DROPDOWN",
              items: projectItems,
              onChangeAction: {
                function: "update_subprojects"
              }
            }
          },
          {
            selectionInput: {
              name: "subproject",
              label: "Sub Project",
              type: "DROPDOWN",
              items: mappedSubOptions
            }
          },
          {
            textInput: {
              name: "do",
              label: "Do",
              type: "MULTIPLE_LINE"
            }
          },
          {
            textInput: {
              name: "obstacle",
              label: "Obstacle",
              type: "MULTIPLE_LINE"
            }
          }
        ]
      }
    ],
    fixedFooter: {
      primaryButton: {
        text: "Submit",
        onClick: {
          action: { function: "submit_report" }
        }
      }
    }
  };
}


// --- 4. EXPRESS SERVER UNTUK MENERIMA WEBHOOK CHAT ---
const app = express();
app.use(express.json());

app.post('/', async (req, res) => {
  try {
    const event = req.body;

    // DEBUG: Log full incoming event
    console.log('\n========== INCOMING EVENT ==========');
    console.log(JSON.stringify(event, null, 2));
    console.log('====================================\n');

    // 1. Ekstrak data dengan cerdas (mendukung format baru Google Chat)
    const user = event.chat?.user || event.user || {};
    const commandId = event.chat?.appCommandPayload?.appCommandMetadata?.appCommandId || event.message?.slashCommand?.commandId;
    const invokedFunction = event.commonEventObject?.invokedFunction || event.common?.invokedFunction;
    const formInputs = event.commonEventObject?.formInputs || event.common?.formInputs;

    // Log untuk memantau aktivitas
    console.log(`📥 Event dari ${user.displayName || 'Unknown'} | CommandID: ${commandId || '-'} | Function: ${invokedFunction || '-'}`);

    // ⚠️ PENTING: Cek invokedFunction DULU sebelum commandId!
    // Karena event CARD_CLICKED (dropdown change, submit) juga membawa commandId,
    // jika commandId dicek duluan, handler update_subprojects/submit_report tidak akan pernah tercapai.

    // B. MENANGANI INTERAKSI KARTU — Dropdown Project Changed
    if (invokedFunction === 'update_subprojects') {
      const date = formInputs?.date?.stringInputs?.value?.[0] || "";
      const project = formInputs?.project?.stringInputs?.value?.[0];

      console.log(`🔄 update_subprojects | Project: "${project}" | Date: "${date}"`);

      let subOpts = [];
      if (project === "kuassa") subOpts = kuassaProjects;
      else if (project === "mixwave") subOpts = mixwaveProjects;

      console.log(`📋 Ditemukan ${subOpts.length} subproject untuk "${project}"`);

      return res.json({
        actionResponse: {
          type: "DIALOG",
          dialogAction: {
            dialog: {
              body: makeDialogCard(date, project, subOpts)
            }
          }
        }
      });
    }

    // B2. Logic Submit Form
    if (invokedFunction === 'submit_report') {
      const displayName = user.displayName;
      const date = formInputs?.date?.stringInputs?.value?.[0];
      const project = formInputs?.project?.stringInputs?.value?.[0];
      const subproject = formInputs?.subproject?.stringInputs?.value?.[0];
      const do_ = formInputs?.do?.stringInputs?.value?.[0] || "";
      const obstacle = formInputs?.obstacle?.stringInputs?.value?.[0] || "";

      try {
        let dateUsed = new Date();
        if (date && /^\d{4}\-\d{2}\-\d{2}$/.test(date)) {
          const [yyyy, mm, dd] = date.split("-");
          dateUsed = new Date(`${yyyy}-${mm}-${dd}T00:00:00+07:00`);
        }

        if (isNaN(dateUsed.getTime())) {
          return res.json({
            actionResponse: {
              type: "DIALOG",
              dialogAction: { actionStatus: { statusCode: "INVALID_ARGUMENT", userFacingMessage: "❌ Wrong date format! use yyyy-mm-dd" } }
            }
          });
        }

        const formattedDate = new Date(dateUsed)
          .toLocaleString("en-GB", { timeZone: "Asia/Jakarta", hour12: false })
          .replace(",", "");

        const sheetName = `Report_${project}`;
        const existing = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${sheetName}!A2:G`,
        });

        const rows = existing.data.values || [];
        const todayStr = formattedDate.split(" ")[0];

        const userRowsToday = rows
          .map((row, idx) => ({ row, idx }))
          .filter(({ row }) => {
            const [rawDate, rowUser] = row;
            return rowUser === displayName && rawDate.split(" ")[0] === todayStr;
          });

        const reportCount = userRowsToday.length + 1;
        const newWeight = +(1.0 / reportCount).toFixed(3);

        for (const { idx } of userRowsToday) {
          const rowIndex = idx + 2;
          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${sheetName}!F${rowIndex}`,
            valueInputOption: "RAW",
            requestBody: { values: [[newWeight]] },
          });
        }

        const weekNumber = getWeekOfMonth(dateUsed);
        const newRow = [[formattedDate, displayName, subproject, do_, obstacle, newWeight, weekNumber]];

        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `${sheetName}!A:G`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: newRow },
        });

        return res.json({
          actionResponse: {
            type: "DIALOG",
            dialogAction: {
              actionStatus: {
                statusCode: "OK",
                userFacingMessage: "✅ Report submitted successfully!"
              }
            }
          }
        });

      } catch (e) {
        console.error(e);
        return res.json({
          actionResponse: {
            type: "DIALOG",
            dialogAction: {
              actionStatus: {
                statusCode: "INTERNAL",
                userFacingMessage: "❌ Failed to submit report. Check logs."
              }
            }
          }
        });
      }
    }

    // A. MENANGANI SLASH COMMAND /report (ID 1) — buka dialog awal
    if (commandId == 1) {
      const today = new Date().toISOString().split("T")[0];

      const response = {
        actionResponse: {
          type: "DIALOG",
          dialogAction: {
            dialog: {
              body: makeDialogCard(today, null, [])
            }
          }
        }
      };
      console.log('📤 Response /report:', JSON.stringify(response, null, 2));
      return res.json(response);
    }

    // Command /refresh (ID 2)
    if (commandId == 2) {
      kuassaProjects = await getSubProjects("kuassa");
      mixwaveProjects = await getSubProjects("mixwave");
      return res.json({ text: "✅ List has been refreshed" });
    }

    // Fallback
    console.log('⚠️ Fallback: No handler matched for this event');
    return res.status(200).json({});

  } catch (error) {
    console.error('❌ UNCAUGHT ERROR in handler:', error);
    return res.status(200).json({
      text: '❌ Internal error occurred. Check server logs.'
    });
  }
});

// --- 5. JALANKAN SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initGoogle();
  console.log(`⚡ Google Chat bot is running on port ${PORT}!`);
});