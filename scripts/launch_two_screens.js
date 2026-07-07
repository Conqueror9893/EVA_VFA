// scripts/launch_two_screens.js
const { exec } = require("child_process");
const session = Date.now().toString();
const base = "http://localhost:3000";
const avatarUrl = `${base}/welcome.html?role=avatar&twoTab=1&session=${session}`;
const journeyUrl = `${base}/journey_screen.html?role=journey&twoTab=1&session=${session}`;

exec(`start "" "${avatarUrl}"`);
exec(`start "" "${journeyUrl}"`);

console.log({ session, avatarUrl, journeyUrl });
