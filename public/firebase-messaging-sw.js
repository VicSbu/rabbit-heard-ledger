// Required by Firebase Cloud Messaging for web push. Must live at the site
// root (public/firebase-messaging-sw.js) so the browser can register it.
//
// This needs the SAME firebaseConfig values as public/index.html — service
// workers run in a separate context and can't read variables from the page,
// so the config has to be duplicated here. Fill in both places identically.

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
});

var messaging = firebase.messaging();

// Shows a notification when a push arrives while the app isn't in the foreground.
messaging.onBackgroundMessage(function(payload) {
  var title = (payload.notification && payload.notification.title) || 'Warren';
  var options = {
    body: (payload.notification && payload.notification.body) || '',
    icon: '/favicon.ico'
  };
  self.registration.showNotification(title, options);
});
