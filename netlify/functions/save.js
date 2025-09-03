// netlify/functions/save.js
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

export async function handler(event, context) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    const body = JSON.parse(event.body || "{}");
    if (!body.ticker || !body.creator_handle) {
      return { statusCode: 400, body: "Missing ticker or creator_handle" };
    }

    const id = `xcom_${body.ticker}_${body.creator_handle}`;
    await db.collection("xcoms").doc(id).set(body, { merge: true });

    return { statusCode: 200, body: JSON.stringify({ ok: true, id }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "server_error" }) };
  }
}
