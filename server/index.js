require("dotenv").config();

const path = require("path");
const express = require("express");
const lti = require("ltijs").Provider;

// ---- LTI setup (MongoDB Atlas) ----
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

// Serve static files
lti.app.use(express.json());
lti.app.use(express.static(path.join(__dirname, "..", "public")));

// Simple health check (useful if you open the URL directly)
lti.app.get("/health", (req, res) => res.send("OK"));

// ---- LTI Launch: send the page DIRECTLY (no redirect) ----
lti.onConnect((token, req, res) => {
  // Ltijs includes ltik in the launch URL query
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

// ---- Grade update endpoint ----
lti.app.post("/api/update", async (req, res) => {
  try {
    const token = res.locals.token;
    if (!token) return res.status(401).send("Missing/invalid ltik");

    const score = Number(req.body.score || 0);
    const attempts = Number(req.body.attempts || 0);

    const grade = lti.GradeService(token);

    const scoreLineItem =
      (await grade.getLineItemByLabel("Score")) ||
      (await grade.createLineItem({
        label: "Score",
        scoreMaximum: 10,
        resourceId: "score"
      }));

    await grade.submitScore(scoreLineItem.id, {
      userId: token.user,
      scoreGiven: score,
      scoreMaximum: 10,
      comment: `Attempts: ${attempts}`,
      activityProgress: "Completed",
      gradingProgress: "FullyGraded"
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).send(String(e));
  }
});

// ---- Start then register platform ----
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
