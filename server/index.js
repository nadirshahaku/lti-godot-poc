require("dotenv").config();

const path = require("path");
const express = require("express");
const lti = require("ltijs").Provider;

// ----------------------------------------------------
// 1) Setup Ltijs (MongoDB Atlas is required by ltijs)
// ----------------------------------------------------
lti.setup(
  process.env.LTI_ENCRYPTION_KEY,
  { url: process.env.LTI_DB_URL },
  {
    appRoute: "/",
    loginRoute: "/login",
    keysetRoute: "/keys",
    cookies: { secure: true, sameSite: "none" },
    devMode: false
  }
);

// ----------------------------------------------------
// 2) Middleware + static hosting
// ----------------------------------------------------
lti.app.use(express.json());
lti.app.use(express.static(path.join(__dirname, "..", "public")));

lti.app.get("/health", (req, res) => res.send("OK"));

// ----------------------------------------------------
// 3) LTI Launch (send page directly to avoid loops)
// ----------------------------------------------------
lti.onConnect((token, req, res) => {
  const ltik = req.query.ltik || "";

  return res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Godot LTI POC</title>
</head>
<body style="font-family:sans-serif;margin:16px;">
  <h2>Godot LTI POC</h2>
  <p>Game loads below:</p>

  <iframe
    src="/game/index.html?ltik=${encodeURIComponent(ltik)}"
    style="width:960px;height:600px;border:1px solid #ccc;border-radius:8px;"
  ></iframe>
</body>
</html>
  `);
});

// ----------------------------------------------------
// 4) Grade endpoint (THIS is the ltijs-supported way)
//     - uses res.locals.token (set by ltijs when ltik is provided)
//     - uses lti.Grade.getLineItems/createLineItem/submitScore
//     - includes timestamp (helps Moodle accept score)
// ----------------------------------------------------
lti.app.post("/api/update", async (req, res) => {
  try {
    const idtoken = res.locals.token; // provided by ltijs when request includes ?ltik=
    if (!idtoken) return res.status(401).send("Unauthorized: missing/invalid ltik");

    const score = Number(req.body.score || 0);
    const attempts = Number(req.body.attempts || 0);

    // Keep score within 0..10 (Moodle can reject “incorrect score”)
    const scoreClamped = Math.max(0, Math.min(10, score));

    // Score payload (include timestamp)
    const gradeObj = {
      userId: idtoken.user,
      scoreGiven: scoreClamped,
      scoreMaximum: 10,
      activityProgress: "Completed",
      gradingProgress: "FullyGraded",
      timestamp: new Date().toISOString(),
      comment: `Attempts: ${attempts}`
    };

    // 1) Try to use lineitem id from token (fast path)
    let lineItemId = idtoken?.platformContext?.endpoint?.lineitem;

    // 2) Otherwise, fetch line items for this resource link and reuse/create
    if (!lineItemId) {
      const response = await lti.Grade.getLineItems(idtoken, { resourceLinkId: true });
      const lineItems = response?.lineItems || [];

      if (lineItems.length === 0) {
        const newLineItem = {
          scoreMaximum: 10,
          label: "Score",
          tag: "score",
          resourceLinkId: idtoken.platformContext.resource.id
        };
        const created = await lti.Grade.createLineItem(idtoken, newLineItem);
        lineItemId = created.id;
      } else {
        // Reuse first line item for this activity
        lineItemId = lineItems[0].id;
      }
    }

    // 3) Submit the score
    const responseGrade = await lti.Grade.submitScore(idtoken, lineItemId, gradeObj);

    return res.json({ ok: true, posted: { score: scoreClamped, attempts }, responseGrade });
  } catch (err) {
    // Return real error text so you can see exactly what Moodle/ltijs says
    return res.status(500).send(err?.message || String(err));
  }
});

// ----------------------------------------------------
// 5) Start then register Moodle platform
// ----------------------------------------------------
(async () => {
  try {
    const port = process.env.PORT || 3000;

    await lti.deploy({ port });
    console.log("Running on", port);

    await lti.registerPlatform({
      url: "https://quizgametest.moodlecloud.com",
      name: "MoodleCloud QuizGameTest",
      clientId: "GzMJPZMQfLMVRts",
      authenticationEndpoint: "https://quizgametest.moodlecloud.com/mod/lti/auth.php",
      accesstokenEndpoint: "https://quizgametest.moodlecloud.com/mod/lti/token.php",
      authConfig: {
        method: "JWK_SET",
        key: "https://quizgametest.moodlecloud.com/mod/lti/certs.php"
      },
      deploymentId: "2"
    });

    console.log("Platform registered.");
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
})();
