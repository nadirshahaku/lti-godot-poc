require("dotenv").config();

const path = require("path");
const express = require("express");
const lti = require("ltijs").Provider;

// 1) Setup Ltijs (MongoDB is required by ltijs)
lti.setup(
  process.env.LTI_ENCRYPTION_KEY,
  { url: process.env.LTI_DB_URL },
  {
    // ✅ IMPORTANT: launch route is /launch (not /)
    appRoute: "/launch",
    loginRoute: "/login",
    keysetRoute: "/keys",
    cookies: { secure: true, sameSite: "none" },
    devMode: false
  }
);

// 2) Middleware + static files
lti.app.use(express.json());
lti.app.use(express.static(path.join(__dirname, "..", "public")));

// Friendly home page (so / never shows 400)
lti.app.get("/", (req, res) => {
  res.send(`
    <h2>LTI Godot POC</h2>
    <p>This tool must be launched from Moodle.</p>
    <p>Health: <a href="/health">/health</a></p>
  `);
});

lti.app.get("/health", (req, res) => res.send("OK"));

// 3) LTI Launch handler (no redirect loops)
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

// 4) Grade endpoint (ltijs official Grade static API)
lti.app.post("/api/update", async (req, res) => {
  try {
    const idtoken = res.locals.token;
    if (!idtoken) return res.status(401).send("Unauthorized: missing/invalid ltik");

    const score = Number(req.body.score || 0);
    const attempts = Number(req.body.attempts || 0);
    const scoreClamped = Math.max(0, Math.min(10, score));

    const gradeObj = {
      userId: idtoken.user,
      scoreGiven: scoreClamped,
      scoreMaximum: 10,
      activityProgress: "Completed",
      gradingProgress: "FullyGraded",
      timestamp: new Date().toISOString(),
      comment: `Attempts: ${attempts}`
    };

    // Get or create line item
    let lineItemId = idtoken?.platformContext?.endpoint?.lineitem;

    if (!lineItemId) {
      const response = await lti.Grade.getLineItems(idtoken, { resourceLinkId: true });
      const lineItems = response?.lineItems || [];

      if (lineItems.length === 0) {
        const created = await lti.Grade.createLineItem(idtoken, {
          scoreMaximum: 10,
          label: "Score",
          tag: "score",
          resourceLinkId: idtoken.platformContext.resource.id
        });
        lineItemId = created.id;
      } else {
        lineItemId = lineItems[0].id;
      }
    }

    await lti.Grade.submitScore(idtoken, lineItemId, gradeObj);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).send(err?.message || String(err));
  }
});

// 5) Start then register platform
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
