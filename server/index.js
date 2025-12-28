require("dotenv").config();

const fs = require("fs");
const express = require("express");
const path = require("path");

// ✅ Ltijs v5+: Provider is not a constructor. Use lti.setup(...)
const lti = require("ltijs").Provider;

// Firestore plugin (works with Firebase Spark)
const { Firestore } = require("@examind/ltijs-firestore");

// Write Firebase service account JSON into a file at runtime (Render-friendly)
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  const credsPath = "/tmp/service-account.json";
  fs.writeFileSync(credsPath, process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  process.env.LTIJS_APPLICATION_CREDENTIALS = credsPath;
}

// Setup Ltijs with Firestore storage
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

// Express middleware inside Ltijs app
lti.app.use(express.json());
lti.app.use(express.static(path.join(__dirname, "..", "public")));

function getUser(token) {
  const email = token?.userInfo?.email || token?.email || "unknown@example.com";
  const name = token?.userInfo?.name || token?.name || "Unknown User";
  return { email, name };
}

function launchHtml(user) {
  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Godot LTI POC</title>
</head>
<body style="font-family:sans-serif;margin:16px;">
  <h2>Godot LTI POC</h2>
  <div style="margin-bottom:12px;">
    Logged in as: <b>${user.name}</b> (${user.email})
  </div>

  <p>Game loads below:</p>

  <iframe
    src="/game/index.html"
    style="width:960px;height:600px;border:1px solid #ccc;border-radius:8px;"
  ></iframe>

  <script>
    // Godot Web calls this on every click
    window.updateToMoodle = async function(score, attempts, isExit) {
      const r = await fetch("/api/update", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ score, attempts, isExit: !!isExit })
      });

      if (!r.ok) console.warn("Update failed:", await r.text());
      if (isExit) window.close();
    };
  </script>
</body>
</html>`;
}

// LTI launch handler
lti.onConnect(async (token, req, res) => {
  const user = getUser(token);
  return res.send(launchHtml(user));
});

// Post grades back to Moodle (Score + Attempts)
lti.app.post("/api/update", lti.authenticate(), async (req, res) => {
  try {
    const token = res.locals.token;

    const score = Number(req.body.score || 0);
    const attempts = Number(req.body.attempts || 0);

    const grade = lti.GradeService(token);

    const scoreLineItem =
      (await grade.getLineItemByLabel("Score")) ||
      (await grade.createLineItem({ label: "Score", scoreMaximum: 10, resourceId: "score" }));

    const attemptsLineItem =
      (await grade.getLineItemByLabel("Attempts")) ||
      (await grade.createLineItem({ label: "Attempts", scoreMaximum: 1000, resourceId: "attempts" }));

    await grade.submitScore(scoreLineItem.id, {
      userId: token.user,
      scoreGiven: score,
      scoreMaximum: 10,
      comment: `Attempts: ${attempts}`,
      activityProgress: "Completed",
      gradingProgress: "FullyGraded"
    });

    await grade.submitScore(attemptsLineItem.id, {
      userId: token.user,
      scoreGiven: attempts,
      scoreMaximum: 1000,
      comment: `Score: ${score}`,
      activityProgress: "Completed",
      gradingProgress: "FullyGraded"
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).send(String(e));
  }
});

// Start the service
(async () => {
  const port = process.env.PORT || 3000;
  await lti.deploy({ port });
  console.log("Running on", port);

  // ✅ Later we will add: lti.registerPlatform({...}) after Moodle provides values
})();
