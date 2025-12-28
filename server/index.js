require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");

// Ltijs Provider (v5+)
const lti = require("ltijs").Provider;

// Firestore plugin
const { Firestore } = require("@examind/ltijs-firestore");

// --------------------
// 0) Firebase credentials from Render env var
// --------------------
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  const credsPath = "/tmp/service-account.json";
  fs.writeFileSync(credsPath, process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  process.env.LTIJS_APPLICATION_CREDENTIALS = credsPath;
}

// --------------------
// 1) Setup Ltijs
// --------------------
lti.setup(
  process.env.LTI_ENCRYPTION_KEY,
  { plugin: new Firestore({ collectionPrefix: "ltijs-" }) },
  {
    appRoute: "/",
    loginRoute: "/login",
    keysetRoute: "/keys",
    cookies: { secure: true, sameSite: "none" },
    devMode: false
  }
);

// --------------------
// 2) Middleware + static files
// --------------------
lti.app.use(express.json());
lti.app.use(express.static(path.join(__dirname, "..", "public")));

// --------------------
// 3) After LTI launch, redirect to /game with ltik
// --------------------
lti.onConnect((token, req, res) => {
  return lti.redirect(res, "/game");
});

// --------------------
// 4) Game wrapper page
// (passes ltik to the placeholder/game iframe)
// --------------------
lti.app.get("/game", (req, res) => {
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

// --------------------
// 5) Grade update endpoint
// Client must call: /api/update?ltik=XXXX
// --------------------
lti.app.post("/api/update", async (req, res) => {
  try {
    const token = res.locals.token;

    if (!token) {
      return res
        .status(401)
        .send('Unauthorized: missing ltik (call /api/update?ltik=YOUR_LTIK)');
    }

    const score = Number(req.body.score || 0);
    const attempts = Number(req.body.attempts || 0);

    const grade = lti.GradeService(token);

    // Create/get "Score" column
    const scoreLineItem =
      (await grade.getLineItemByLabel("Score")) ||
      (await grade.createLineItem({
        label: "Score",
        scoreMaximum: 10,
        resourceId: "score"
      }));

    // Send score to Moodle gradebook (attempts goes into comment)
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

// --------------------
// 6) Start service + register Moodle platform
// --------------------
(async () => {
  try {
    // IMPORTANT: Register platform BEFORE deploy
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

    const port = process.env.PORT || 3000;
    await lti.deploy({ port });
    console.log("Running on", port);
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
})();
