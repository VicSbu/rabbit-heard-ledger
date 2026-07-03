# Warren on Firebase

Everything lives in one Firebase project now:

- **Firebase Hosting** — serves `public/index.html`, the whole app
- **Firebase Authentication** — email/password login
- **Firestore** — the database (rabbits, litters, health, feed, ledger, farms, members)
- **Cloud Functions** — two small functions (`createFarm`, `addFarmMember`) for the
  two operations that need admin privileges; everything else talks to
  Firestore directly from the browser, secured by `firestore.rules`

No separate server or Postgres database to run or pay for.

## 1. Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**
2. In the new project, enable:
   - **Build → Authentication → Get started → Email/Password** (enable the sign-in method)
   - **Build → Firestore Database → Create database** (start in production mode — our
     `firestore.rules` handles security)
3. **Upgrade to the Blaze (pay-as-you-go) plan.** Cloud Functions require it — but Firebase's
   free monthly quotas (2M function invocations, generous Firestore reads/writes) mean a
   farm app like this will very likely cost $0/month in practice.

## 2. Get your web app config

Project settings (gear icon) → **General** → scroll to **Your apps** → **Add app → Web**.
Give it a nickname, skip hosting setup in the wizard (we already have `firebase.json`),
and copy the `firebaseConfig` object it shows you.

Paste it into `public/index.html`, replacing the placeholder near the top of the
`<script>` block:

```js
var firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

## 3. Install tools and connect this folder to your project

```bash
npm install -g firebase-tools
firebase login

cd warren-firebase
firebase use --add          # pick your project, give it an alias like "default"
```

## 4. Install Cloud Functions dependencies

```bash
cd functions
npm install
cd ..
```

## 5. Deploy everything

```bash
firebase deploy
```

This pushes Hosting, Firestore rules, and both Cloud Functions in one go. Firebase
prints your live URL:

```
https://your-project-id.web.app
```

To deploy just one piece later (faster iteration):

```bash
firebase deploy --only hosting
firebase deploy --only firestore:rules
firebase deploy --only functions
```

## 6. Try it

Visit your Hosting URL, register an account, and you'll land on "Set up your farm" —
name it and pick a currency. You're the farm manager. From the **Team** tab you can add
anyone else who has registered, and set their role:

| Role | Can do |
|---|---|
| viewer | Look at everything, change nothing |
| worker | Add/edit rabbits, litters, health records, feed, ledger |
| supervisor | Everything worker can, plus delete records |
| farm_manager | Everything, plus manage members, roles, and farm settings (name, currency) |

## How data isolation works

Every record (`rabbits`, `litters`, `health`, `feedStock`, `feedTx`, `ledger`) lives
under `farms/{farmId}/...` in Firestore, and `firestore.rules` checks that the
requesting user has a `farms/{farmId}/members/{uid}` document — and the right role —
before allowing any read or write. This is enforced by Firestore itself, not by
frontend code, so it holds even if someone tampers with the page in their browser.
One farm can never see or touch another farm's data.

## Why two Cloud Functions instead of zero

Almost everything is a direct Firestore read/write from the browser, protected by
security rules — no server needed. Two things specifically can't be done safely that
way:

- **`createFarm`** — bootstrapping a brand-new farm plus the creator's "I'm the
  manager" membership record in one step. Doing this purely with client-side rules
  risks letting someone self-promote to manager on a farm that already exists (rules
  can't easily distinguish "creating a new farm" from "editing an existing one" mid-batch).
- **`addFarmMember`** — looking up another user's account by email requires the Admin
  Auth API. The client SDK deliberately can't look up other users by email (privacy).

Both functions double-check the caller's permissions server-side before doing anything.

## Local testing (optional)

```bash
firebase emulators:start
```

Runs Auth, Firestore, and Functions locally. Point `firebaseConfig` at nothing special —
just also call `firebase.auth().useEmulator(...)` etc. if you want to test against the
emulator instead of production (not wired up by default in `index.html`, to keep the
file simple — ask if you want that added).

## What's not included (by design, to keep v1 shippable)

- Email-based invite links — v1 requires the invitee to register first, then a manager
  adds them by email
- Password reset flow (Firebase Auth supports this out of the box —
  `auth.sendPasswordResetEmail(email)` — just not wired into the UI yet)
- Removing the "last manager" is only guarded client-side, not by security rules
