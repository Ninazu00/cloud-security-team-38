import "dotenv/config";
import app from "./app.js";

const PORT = Number(process.env.PORT) || 3002;
const env = process.env.NODE_ENV || "development";

app.listen(PORT, () => {
  console.log(`Timetable Service listening on http://localhost:${PORT} (${env})`);
});
