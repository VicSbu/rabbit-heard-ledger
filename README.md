# Rabbit Heard Ledger

Rabbit Heard Ledger is a Firebase-hosted herd management dashboard built to track rabbit farms, animals, litters, health records, feed inventory, and financial ledger entries.

## What this app does

- User authentication with Firebase Email/Password
- Farm creation and membership management
- Role-based access control for farm data
- Live Firestore-backed tracking of:
  - rabbits
  - litters and breeding
  - health records
  - feed inventory and transactions
  - ledger entries and farm finances
- Minimal server-side logic via Firebase Cloud Functions for secure farm setup and member onboarding
- Everything else runs client-side in the browser using Firestore and Firebase security rules

## Key features

- Farm owners can create farms and pick a currency
- Farm managers can invite or add members by email
- Members can be assigned roles:
  - `viewer` — read-only access
  - `worker` — create and edit farm records
  - `supervisor` — worker access plus delete permissions
  - `farm_manager` — full control, including team and farm settings
- Data is scoped under `farms/{farmId}/...` so each farm is isolated in Firestore

## Project structure

- `public/` — single-page web app served by Firebase Hosting
  - `index.html` — app shell, UI, and Firebase setup
  - `firebase-messaging-sw.js` — service worker for Firebase Messaging
- `functions/` — Cloud Functions for elevated admin operations
  - `index.js` — callable functions used by the frontend
  - `package.json` — function dependencies
- `firebase.json` — Firebase project configuration
- `firestore.rules` — Firestore security rules for farm and member access
- `firestore.indexes.json` — Firestore index configuration

## Setup

1. Install the Firebase CLI:

```bash
npm install -g firebase-tools
```

2. Login to Firebase:

```bash
firebase login
```

3. Initialize the project alias if not already configured:

```bash
firebase use --add
```

4. Create a Firebase project in the console and enable:
   - Authentication → Email/Password
   - Firestore Database

5. Add a web app in Firebase Console and copy the `firebaseConfig` values.

6. Open `public/index.html` and paste the `firebaseConfig` object into the script near the top.

7. Install Functions dependencies:

```bash
cd functions
npm install
cd ..
```

8. Deploy the app:

```bash
firebase deploy
```

To deploy only a specific part later:

```bash
firebase deploy --only hosting
firebase deploy --only firestore:rules
firebase deploy --only functions
```

## Running locally (optional)

Use the Firebase emulator suite for local testing:

```bash
firebase emulators:start
```

If you want to test locally, you may also configure the app to use the Auth, Firestore, and Functions emulators.

## Cloud Functions

This project uses two callable Cloud Functions:

- `createFarm` — creates a new farm document and bootstraps the current user as its `farm_manager`
- `addFarmMember` — looks up or creates a user by email, then adds them to the farm with a role

These functions are required because the frontend cannot safely perform these operations with Firestore security rules alone.

## Optional email onboarding

The functions code can send setup emails when a new user is created if `SENDGRID_API_KEY` is configured in the Functions environment. Without this, a new member will still be created, but email delivery is skipped.

## Notes

- The frontend is a static Firebase-hosted app with no separate backend server
- Firestore security rules enforce membership and role-based access
- Farm data is isolated by `farmId`, so one farm cannot access another farm's records

## License

This repository does not include a license file. Add one if you want to publish or share the project publicly.
