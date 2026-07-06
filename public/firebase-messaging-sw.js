// Required by Firebase Cloud Messaging for web push. Must live at the site
// root (public/firebase-messaging-sw.js) so the browser can register it.
//
// This needs the SAME firebaseConfig values as public/index.html — service
// workers run in a separate context and can't read variables from the page,
// so the config has to be duplicated here. Fill in both places identically.

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDc6Yne4veS8b7EN7LmvJhTsy8sFhMrGTk",
  authDomain: "rabbit-heard-leadger.firebaseapp.com",
  projectId: "rabbit-heard-leadger",
  storageBucket: "rabbit-heard-leadger.firebasestorage.app",
  messagingSenderId: "112359733558",
  appId: "1:112359733558:web:e5df3a5d8d5211387d5b97",
  measurementId: "G-7TXMCL1CE6"
});

var messaging = firebase.messaging();

// Shows a notification when a push arrives while the app isn't in the foreground.
messaging.onBackgroundMessage(function(payload) {
  var title = (payload.notification && payload.notification.title) || 'Rabbit Heard Ledger';
  var options = {
    body: (payload.notification && payload.notification.body) || '',
    icon: '/favicon.ico'
  };
  self.registration.showNotification(title, options);
});
