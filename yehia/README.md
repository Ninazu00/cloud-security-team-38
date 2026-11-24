# Timetable Service — Class Timetable Builder

**Owner:** Yehia Mohamed (248678) — Group 38 (BUE)

Standalone microservice for clash detection, valid timetable generation with conflict explanation, saved timetables with ownership checks, `.ics` export, and async stale flagging via EventBridge + SQS.

## Quick Start (Mock Mode)
```bash
npm install
cp .env.example .env
node scripts/setup-aws.js
node scripts/mint-token.js student-1 student
npm test
npm run dev
```

## Deploy to Floci (Lambda + API Gateway + SQS Consumer)
```bash
bash infra/deploy-floci.sh
```
