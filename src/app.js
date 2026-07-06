(function(){


  // ============ FIREBASE CONFIG ============
  var REQUIRED_FIREBASE_KEYS = ['apiKey','authDomain','projectId','storageBucket','messagingSenderId','appId'];
  var firebaseConfig = window.__RHL_FIREBASE_CONFIG__ || {};

  function isPlaceholder(v){ return !v || /^YOUR_/.test(String(v)); }
  var missingFields = REQUIRED_FIREBASE_KEYS.filter(function(k){ return isPlaceholder(firebaseConfig[k]); });
  var configured = missingFields.length === 0;
  if(!configured){
    document.getElementById('root').innerHTML =
      '<div class="w-configwarn"><h2 style="margin-bottom:8px;">One setup step left</h2>'+
      '<p>This page needs your Firebase project\'s config. Update <code>src/firebase-config.js</code> '+
      'with the values from <b>Firebase Console → Project settings → General → Your apps → Web app</b>, '+
      'then redeploy.</p>'+
      '<p style="margin-top:10px;"><b>Missing or placeholder values:</b> '+missingFields.map(function(k){return '<code>'+k+'</code>';}).join(', ')+
      '.</p></div>';
    console.warn('Rabbit Heard Ledger: firebase config is incomplete for:', missingFields);
    return;
  }

  firebase.initializeApp(firebaseConfig);
  var auth = firebase.auth();
  var db = firebase.firestore();
  db.settings({
    experimentalAutoDetectLongPolling: true,
    useFetchStreams: false,
  });
  var fx = firebase.functions();
  var messaging = null;
  var FCM_VAPID_KEY = ''; // Optional: set your Firebase Web Push VAPID key if required for getToken

  var CURRENCY_SYMBOLS = {USD:'$',EUR:'€',GBP:'£',ZAR:'R',SZL:'E',KES:'KSh',NGN:'₦',GHS:'GH₵',INR:'₹',AUD:'A$',CAD:'C$',BWP:'P',ZMW:'K'};
  var CURRENCIES = ['USD','EUR','GBP','ZAR','SZL','KES','NGN','GHS','INR','AUD','CAD','BWP','ZMW'];
  var ROLE_RANK = {viewer:0, worker:1, supervisor:2, farm_manager:3};
  function can(minRole){ return (ROLE_RANK[currentRole]||0) >= ROLE_RANK[minRole]; }
  function canManageTeam(){ return can('supervisor'); }
  function canAssignTeamRole(role){ return can('farm_manager') || role !== 'farm_manager'; }
  function findTeamMember(uid){ return teamMembers.find(function(m){ return m.uid === uid; }); }
  function canEditTeamMember(member){
    if(!member || !canManageTeam()) return false;
    if(can('farm_manager')) return true;
    return member.role !== 'farm_manager';
  }

  var FS_COLLECTION = {rabbits:'rabbits', cages:'cages', litters:'litters', health:'health', feedStock:'feedStock', ledger:'ledger', tasks:'tasks', taskLogs:'taskLogs'};

  var currentUser = null;
  var farms = [];
  var currentFarm = null; // {id,name,currency,role}
  var currentRole = 'viewer';
  var state = {rabbits:[], cages:[], litters:[], health:[], feedStock:[], ledger:[], tasks:[], taskLogs:[]};
  var current = 'dashboard';
  var GEST_DAYS = 31;
  var PALPATION_DAYS = 14;
  var WEAN_TARGET_DAYS = 42;
  var BREED_RANK_MIN_KINDLED = 2;
  var appScreen = 'auth'; // auth | pickfarm | newfarm | app
  var authMode = 'login';
  var authError = '';
  var loading = false;
  var mustChangePassword = false;
  var memberNotice = null;

  // ============ HELPERS ============
  function todayStr(){ return new Date().toISOString().slice(0,10); }
  function fmtDate(d){ if(!d) return '—'; if (d && typeof d.toDate === 'function') d = d.toDate(); if (typeof d === 'object' && d.seconds != null) d = new Date(d.seconds * 1000); if (typeof d === 'string') d = new Date(d+'T00:00:00'); if (!(d instanceof Date)) d = new Date(d); if(isNaN(d)) return String(d); return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); }
  function addDays(d,n){ var dt=new Date(d+'T00:00:00'); dt.setDate(dt.getDate()+n); return dt.toISOString().slice(0,10); }
  function daysFromToday(d){ if(!d) return 999; var a=new Date(todayStr()+'T00:00:00'); var b=new Date(d+'T00:00:00'); return Math.round((b-a)/86400000); }
  function esc(s){ return (s===undefined||s===null)?'':String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function money(n){ var sym = CURRENCY_SYMBOLS[currentFarm&&currentFarm.currency] || ((currentFarm&&currentFarm.currency)||'USD')+' '; return sym+(Number(n)||0).toFixed(2); }
  function rabbitById(id){ return state.rabbits.find(function(r){return r.id===id;}); }
  function litterById(id){ return state.litters.find(function(l){return l.id===id;}); }
  function cageById(id){ return state.cages.find(function(c){return c.id===id;}); }
  function feedItemById(id){ return state.feedStock.find(function(f){return f.id===id;}); }
  function isLowStock(item){ return Number(item.quantity) <= Number(item.reorderLevel); }
  function snapToArr(snap){ return snap.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); }); }
  function dataAttrs(attrs){
    return Object.keys(attrs).filter(function(key){ return attrs[key] !== undefined && attrs[key] !== null; }).map(function(key){
      return ' data-' + key + '="' + esc(attrs[key]) + '"';
    }).join('');
  }
  function clickAttrs(action, attrs){ return dataAttrs(Object.assign({action:action}, attrs || {})); }
  function changeAttrs(action, attrs){ return dataAttrs(Object.assign({change:action}, attrs || {})); }
  function inputAttrs(action, attrs){ return dataAttrs(Object.assign({input:action}, attrs || {})); }

  function bindUiEvents(){
    if(bindUiEvents.bound) return;
    bindUiEvents.bound = true;

    document.addEventListener('click', function(event){
      var target = event.target.closest('[data-action]');
      if(!target) return;
      var action = target.dataset.action;
      if(!action) return;
      if(action === 'close-modal-overlay' && event.target !== target) return;
      handleUiAction(action, target, event);
    });

    document.addEventListener('change', function(event){
      var target = event.target.closest('[data-change]');
      if(!target) return;
      handleUiChange(target.dataset.change, target, event);
    });

    document.addEventListener('input', function(event){
      var target = event.target.closest('[data-input]');
      if(!target) return;
      handleUiInput(target.dataset.input, target, event);
    });
  }

  function handleUiAction(action, target){
    if(action === 'set-auth-mode') return setAuthMode(target.dataset.mode);
    if(action === 'request-password-reset') return requestPasswordReset();
    if(action === 'pick-farm') return pickFarm(target.dataset.id);
    if(action === 'go-new-farm') return goNewFarm();
    if(action === 'logout') return logout();
    if(action === 'back-to-pick') return backToPick();
    if(action === 'open-menu') return openMenu();
    if(action === 'close-menu') return closeMenu();
    if(action === 'go-view') return go(target.dataset.view);
    if(action === 'open-task-modal') return openTaskModal(target.dataset.id || null);
    if(action === 'complete-task') return completeTask(target.dataset.id);
    if(action === 'delete-task') return deleteTask(target.dataset.id);
    if(action === 'close-modal') return closeModal();
    if(action === 'close-modal-overlay') return closeModal();
    if(action === 'open-rabbit-modal') return openRabbitModal(target.dataset.id || null);
    if(action === 'open-rabbit-detail') return openRabbitDetail(target.dataset.id);
    if(action === 'delete-rabbit') return deleteRabbit(target.dataset.id);
    if(action === 'open-litter-modal') return openLitterModal(target.dataset.id || null);
    if(action === 'delete-litter') return deleteLitter(target.dataset.id);
    if(action === 'open-health-modal') return openHealthModal(target.dataset.rabbitId || null, target.dataset.prefillType || null);
    if(action === 'open-cage-modal') return openCageModal(target.dataset.id || null);
    if(action === 'delete-cage') return deleteCage(target.dataset.id);
    if(action === 'open-feed-item-modal') return openFeedItemModal(target.dataset.id || null);
    if(action === 'open-feed-adjust-modal') return openFeedAdjustModal(target.dataset.id, target.dataset.kind);
    if(action === 'delete-feed-item') return deleteFeedItem(target.dataset.id);
    if(action === 'open-ledger-modal') return openLedgerModal(target.dataset.rabbitId || null, target.dataset.prefillType || null, target.dataset.prefillCategory || null);
    if(action === 'export-ledger-csv') return exportLedgerCsv();
    if(action === 'apply-breeding-custom-range') return applyBreedingCustomRange();
    if(action === 'reset-breeding-custom-range') return resetBreedingCustomRange();
    if(action === 'export-breeding-records-csv') return exportBreedingRecordsCsv();
    if(action === 'export-breeding-queue-csv') return exportBreedingQueueCsv();
    if(action === 'dismiss-member-notice') return dismissMemberNotice();
    if(action === 'show-member-pin') return showMemberPin(target.dataset.uid, target.dataset.email);
    if(action === 'resend-setup-email') return resendSetupEmail(target.dataset.uid, target.dataset.email);
    if(action === 'remove-member') return removeMember(target.dataset.uid);
    if(action === 'edit-rabbit-from-detail'){
      closeModal();
      return openRabbitModal(target.dataset.id);
    }
  }

  function handleUiChange(action, target){
    if(action === 'switch-farm') return switchFarm(target.value);
    if(action === 'change-role') return changeRole(target.dataset.uid, target.value);
    if(action === 'set-herd-filter') return setHerdFilter(target.dataset.key, target.value);
    if(action === 'set-task-filter') return setTaskFilter(target.dataset.key, target.value);
    if(action === 'set-ledger-filter') return setLedgerFilter(target.dataset.key, target.value);
    if(action === 'set-breeding-range') return setBreedingRange(target.value);
    if(action === 'set-breeding-custom-start') return setBreedingCustomDate('start', target.value);
    if(action === 'set-breeding-custom-end') return setBreedingCustomDate('end', target.value);
  }

  function handleUiInput(action, target){
    if(action === 'set-herd-filter') return setHerdFilter(target.dataset.key, target.value);
  }

  bindUiEvents();

  function showToast(msg, isError){
    var el = document.createElement('div');
    el.className = 'w-toast'+(isError?' error':'');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function(){ el.remove(); }, 3800);
  }
  function dismissMemberNotice(){ memberNotice = null; if(current==='team') loadAndRenderTeam(); else renderRoot(); }
  async function requestPasswordReset(){
    var emailInput = document.querySelector('#w-auth-form input[name="email"]');
    var email = (emailInput && emailInput.value ? emailInput.value : '').trim();
    if(!email){ showToast('Enter your email address first.', true); return; }
    try{
      await auth.sendPasswordResetEmail(email);
      showToast('Password reset email sent.');
    }catch(e){ showToast(friendlyError(e), true); }
  }
  function friendlyError(e){
    var msg = (e && e.message) || String(e);
    return msg.replace(/^Firebase:\s*/,'').replace(/\(auth\/[a-z-]+\)\.?/,'').trim();
  }

  // ============ AUTH ============
  auth.onAuthStateChanged(function(user){
    if(user){ currentUser = user; afterLogin(); }
    else { currentUser=null; farms=[]; currentFarm=null; appScreen='auth'; renderRoot(); }
  });

  async function handleAuthSubmit(mode, formData){
    authError='';
    try{
      var email = formData.get('email'), password = formData.get('password');
      if(mode==='register'){
        var cred = await auth.createUserWithEmailAndPassword(email, password);
        await cred.user.updateProfile({displayName: formData.get('name')||''});
      } else {
        await auth.signInWithEmailAndPassword(email, password);
      }
      // onAuthStateChanged fires afterLogin()
    }catch(e){
      authError = friendlyError(e);
      renderRoot();
    }
  }

  async function afterLogin(){
    try{
      await registerFcmToken();
      await checkMustChangePassword();
      var snap = await db.collection('memberships').where('uid','==',currentUser.uid).get();
      farms = snap.docs.map(function(d){ var m=d.data(); return {id:m.farmId, name:m.farmName, currency:m.currency, role:m.role}; });
      farms.sort(function(a,b){ return a.name.localeCompare(b.name); });
      if(mustChangePassword){ renderRoot(); return; }
      if(farms.length===0){ appScreen='newfarm'; renderRoot(); }
      else if(farms.length===1){ await selectFarm(farms[0]); }
      else { appScreen='pickfarm'; renderRoot(); }
    }catch(e){ showToast(friendlyError(e), true); appScreen='pickfarm'; renderRoot(); }
  }

  async function selectFarm(farm){
    currentFarm = Object.assign({}, farm);
    currentRole = farm.role;
    appScreen='app';
    current='dashboard';
    await hydrateCurrentFarmDetails();
    renderRoot();
    await loadFarmData();
  }

  async function hydrateCurrentFarmDetails(){
    if(!currentFarm || !currentFarm.id) return;
    try{
      var farmDoc = await db.collection('farms').doc(currentFarm.id).get();
      if(!farmDoc.exists) return;
      var farmData = farmDoc.data() || {};
      currentFarm = Object.assign({}, currentFarm, {
        name: farmData.name || currentFarm.name,
        currency: farmData.currency || currentFarm.currency,
        timezone: farmData.timezone || currentFarm.timezone || 'UTC',
        address: farmData.address || '',
        website: farmData.website || '',
        contactNumbers: farmData.contactNumbers || '',
        contactEmail: farmData.contactEmail || '',
        contactPerson: farmData.contactPerson || '',
        notes: farmData.notes || ''
      });
      var farmIdx = farms.findIndex(function(f){ return f.id === currentFarm.id; });
      if(farmIdx > -1){
        farms[farmIdx] = Object.assign({}, farms[farmIdx], {
          name: currentFarm.name,
          currency: currentFarm.currency
        });
      }
    }catch(e){ console.warn('Could not load farm details:', e); }
  }

  async function registerFcmToken(){
    if (!firebase.messaging || !navigator.serviceWorker || !('Notification' in window)) return;
    try{
      await registerMessagingServiceWorker();
      if (!messaging) messaging = firebase.messaging();
      messaging.onMessage(function(payload){
        if (payload && payload.notification){
          var title = payload.notification.title || 'Rabbit Heard Ledger';
          var body = payload.notification.body || '';
          showToast(title + ': ' + body);
          if (Notification.permission === 'granted') {
            try{ new Notification(title, {body: body, icon: '/favicon.ico'}); }catch(e){ }
          }
        }
      });
      var permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      var token = FCM_VAPID_KEY ? await messaging.getToken({vapidKey: FCM_VAPID_KEY}) : await messaging.getToken();
      if (!token) return;
      await db.collection('users').doc(currentUser.uid).collection('fcmTokens').doc(token).set({createdAt: firebase.firestore.FieldValue.serverTimestamp()});
    }catch(e){ console.warn('Unable to register FCM token:', e); }
  }

  async function registerMessagingServiceWorker(){
    try{
      await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    }catch(e){ console.warn('FCM service worker registration failed:', e); }
  }

  async function checkMustChangePassword(){
    mustChangePassword = false;
    try{
      var doc = await db.collection('users').doc(currentUser.uid).get();
      if (doc.exists && doc.data().mustChangePassword) mustChangePassword = true;
    }catch(e){ console.warn('Could not check password status:', e); }
  }

  async function submitPasswordChange(password){
    try{
      await currentUser.updatePassword(password);
      await db.collection('users').doc(currentUser.uid).update({mustChangePassword:false});
      mustChangePassword = false;
      showToast('Password updated.');
      await afterLogin();
    }catch(e){ showToast(friendlyError(e), true); }
  }

  function logout(){ auth.signOut(); appScreen='auth'; authMode='login'; authError=''; }

  async function createFarm(name, currency){
    try{
      var createFarmFn = fx.httpsCallable('createFarm');
      var res = await createFarmFn({name:name, currency:currency});
      var farm = res.data;
      farms.push(farm);
      await selectFarm(farm);
      showToast('Farm created — welcome to Rabbit Heard Ledger!');
    }catch(e){ showToast(friendlyError(e), true); renderRoot(); }
  }

  // ============ DATA LOADING ============
  async function loadFarmData(){
    loading = true; renderRoot();
    try{
      var base = db.collection('farms').doc(currentFarm.id);
      var results = await Promise.all([
        base.collection('rabbits').orderBy('createdAt','desc').get(),
        base.collection('cages').orderBy('createdAt','desc').get(),
        base.collection('litters').orderBy('createdAt','desc').get(),
        base.collection('health').orderBy('createdAt','desc').get(),
        base.collection('feedStock').orderBy('createdAt','desc').get(),
        base.collection('ledger').orderBy('createdAt','desc').get(),
        base.collection('tasks').orderBy('name','asc').get(),
        base.collection('taskLogs').orderBy('createdAt','desc').get()
      ]);
      state = {rabbits:snapToArr(results[0]), cages:snapToArr(results[1]), litters:snapToArr(results[2]),
        health:snapToArr(results[3]), feedStock:snapToArr(results[4]), ledger:snapToArr(results[5]),
        tasks:snapToArr(results[6]), taskLogs:snapToArr(results[7])};
    }catch(e){ showToast(friendlyError(e), true); }
    loading = false; renderRoot();
  }
  async function refetch(key){
    var query = db.collection('farms').doc(currentFarm.id).collection(FS_COLLECTION[key]);
    if (key === 'tasks') query = query.orderBy('name','asc');
    else query = query.orderBy('createdAt','desc');
    var snap = await query.get();
    state[key] = snapToArr(snap);
  }
  async function createItem(key, body){
    var col = db.collection('farms').doc(currentFarm.id).collection(FS_COLLECTION[key]);
    var payload = Object.assign({}, body, {createdAt: firebase.firestore.FieldValue.serverTimestamp()});
    var ref = await col.add(payload);
    var doc = await ref.get();
    var row = Object.assign({id:doc.id}, doc.data());
    state[key].unshift(row);
    return row;
  }
  async function updateItem(key, id, body){
    var ref = db.collection('farms').doc(currentFarm.id).collection(FS_COLLECTION[key]).doc(id);
    await ref.update(body);
    var doc = await ref.get();
    var row = Object.assign({id:doc.id}, doc.data());
    var idx = state[key].findIndex(function(x){return x.id===id;});
    if(idx>-1) state[key][idx]=row;
    return row;
  }
  async function deleteItemApi(key, id){
    await db.collection('farms').doc(currentFarm.id).collection(FS_COLLECTION[key]).doc(id).delete();
    state[key] = state[key].filter(function(x){return x.id!==id;});
  }
  async function saveTaskApi(taskId, task){
    var saveTaskFn = fx.httpsCallable('saveTask');
    await saveTaskFn({farmId: currentFarm.id, taskId: taskId || null, task: task});
    await refetch('tasks');
  }
  async function deleteTaskApi(taskId){
    var deleteTaskFn = fx.httpsCallable('deleteTask');
    await deleteTaskFn({farmId: currentFarm.id, taskId: taskId});
    await refetch('tasks');
  }
  async function completeTaskApi(taskId, completion){
    var completeTaskFn = fx.httpsCallable('completeTask');
    await completeTaskFn({farmId: currentFarm.id, taskId: taskId, completion: completion || {}});
    await Promise.all([refetch('tasks'), refetch('taskLogs')]);
  }
  async function saveFeedItemApi(itemId, item){
    var saveFeedItemFn = fx.httpsCallable('saveFeedItem');
    await saveFeedItemFn({farmId: currentFarm.id, itemId: itemId || null, item: item});
    await refetch('feedStock');
  }
  async function deleteFeedItemApi(itemId){
    var deleteFeedItemFn = fx.httpsCallable('deleteFeedItem');
    await deleteFeedItemFn({farmId: currentFarm.id, itemId: itemId});
    await refetch('feedStock');
  }
  async function adjustFeedStockApi(itemId, body){
    var adjustFeedStockFn = fx.httpsCallable('adjustFeedStock');
    await adjustFeedStockFn(Object.assign({farmId: currentFarm.id, itemId: itemId}, body));
    await Promise.all([refetch('feedStock'), refetch('ledger')]);
  }
  async function createLedgerEntryApi(entry){
    var createLedgerEntryFn = fx.httpsCallable('createLedgerEntry');
    await createLedgerEntryFn({farmId: currentFarm.id, entry: entry});
    await refetch('ledger');
  }

  // ============ ROOT RENDER ============
  function renderRoot(){
    var root = document.getElementById('root');
    if(mustChangePassword){ root.innerHTML = viewPasswordChange(); }
    else if(appScreen==='auth') root.innerHTML = viewAuth();
    else if(appScreen==='newfarm') root.innerHTML = viewNewFarm();
    else if(appScreen==='pickfarm') root.innerHTML = viewPickFarm();
    else { root.innerHTML = viewApp(); renderMain(); }
    wireEvents();
  }
  function wireEvents(){
    var authForm = document.getElementById('w-auth-form');
    if(authForm) authForm.onsubmit = function(e){ e.preventDefault(); handleAuthSubmit(authMode, new FormData(e.target)); };
    bindPasswordToggles();
    var passwordForm = document.getElementById('w-password-change-form');
    if(passwordForm) passwordForm.onsubmit = function(e){
      e.preventDefault();
      var f = new FormData(e.target);
      var password = f.get('password');
      var confirm = f.get('confirmPassword');
      if (password !== confirm) { showToast('Passwords do not match', true); return; }
      submitPasswordChange(password);
    };
    var newFarmForm = document.getElementById('w-newfarm-form');
    if(newFarmForm) newFarmForm.onsubmit = function(e){ e.preventDefault(); var f=new FormData(e.target); createFarm(f.get('name'), f.get('currency')); };
  }

  function bindPasswordToggles(){
    Array.prototype.forEach.call(document.querySelectorAll('.w-password-toggle'), function(btn){
      btn.onclick = function(e){
        e.preventDefault();
        var input = document.getElementById(btn.getAttribute('data-password-toggle'));
        if(!input) return;
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.textContent = show ? 'Hide' : 'Show';
      };
    });
  }

  // ============ AUTH SCREEN ============
  function viewAuth(){
    return '<div class="w-authwrap">'+
      '<div style="text-align:center;margin-bottom:18px;">'+
        '<svg viewBox="0 0 24 24" fill="none" stroke="#8A3324" stroke-width="1.6" width="34" height="34"><path d="M8 10c-1-3-1-6 1-7 1.2 1 1.5 3.5 1 6M16 10c1-3 1-6-1-7-1.2 1-1.5 3.5-1 6"/><ellipse cx="12" cy="14" rx="6" ry="6.5"/><circle cx="10" cy="12.5" r=".6" fill="#8A3324"/><circle cx="14" cy="12.5" r=".6" fill="#8A3324"/></svg>'+
        '<h1 style="color:var(--barn);margin-top:6px;">Warren</h1><div style="font-size:.75rem;color:var(--ink-muted);text-transform:uppercase;letter-spacing:1.5px;">Herd Ledger</div>'+
      '</div>'+
      '<div class="w-authcard">'+
        '<div class="w-authtabs">'+
          '<div class="w-authtab '+(authMode==='login'?'active':'')+'"'+clickAttrs('set-auth-mode', {mode:'login'})+'>Log in</div>'+
          '<div class="w-authtab '+(authMode==='register'?'active':'')+'"'+clickAttrs('set-auth-mode', {mode:'register'})+'>Register</div>'+
        '</div>'+
        (authError? '<div class="w-autherr">'+esc(authError)+'</div>' : '')+
        '<form id="w-auth-form">'+
          (authMode==='register'? '<div class="w-field"><label>Name</label><input name="name" required/></div>' : '')+
          '<div class="w-field"><label>Email</label><input type="email" name="email" required/></div>'+
          '<div class="w-field"><label>Password</label><div class="w-password-wrap"><input id="w-auth-password" type="password" name="password" required minlength="6"/><button type="button" class="w-password-toggle" data-password-toggle="w-auth-password">Show</button></div></div>'+ 
          '<div class="w-auth-actions"><button type="button" class="w-link-btn"'+clickAttrs('request-password-reset')+'>Forgot password or PIN?</button></div>'+ 
          '<button type="submit" class="w-btn w-btn-primary" style="width:100%;justify-content:center;">'+(authMode==='login'?'Log in':'Create account')+'</button>'+
        '</form>'+
      '</div>'+
    '</div>';
  }
  function setAuthMode(m){ authMode=m; authError=''; renderRoot(); }

  // ============ FARM PICK / CREATE ============
  function viewPasswordChange(){
    return '<div class="w-authwrap"><div class="w-authcard">'+
      '<h2>Set a new password</h2><div class="w-sub">Your account was created by your farm manager. Update your password now to continue.</div>'+ 
      '<form id="w-password-change-form">'+
        '<div class="w-field"><label>New password</label><div class="w-password-wrap"><input id="w-new-password" type="password" name="password" required minlength="6"/><button type="button" class="w-password-toggle" data-password-toggle="w-new-password">Show</button></div></div>'+ 
        '<div class="w-field"><label>Confirm password</label><div class="w-password-wrap"><input id="w-confirm-password" type="password" name="confirmPassword" required minlength="6"/><button type="button" class="w-password-toggle" data-password-toggle="w-confirm-password">Show</button></div></div>'+ 
        '<button type="submit" class="w-btn w-btn-primary" style="width:100%;justify-content:center;">Save password</button>'+ 
      '</form>'+ 
    '</div></div>';
  }
  function viewPickFarm(){
    return '<div class="w-farmpick"><h2 style="margin-bottom:14px;">Choose a farm</h2>'+
      farms.map(function(f){
        return '<div class="w-farmcard"'+clickAttrs('pick-farm', {id:f.id})+'><div><b>'+esc(f.name)+'</b><div style="font-size:.75rem;color:var(--ink-muted);">'+esc(f.currency)+'</div></div><span class="w-pill pill-moss">'+esc(f.role)+'</span></div>';
      }).join('')+
      '<button class="w-btn w-btn-ghost" style="width:100%;justify-content:center;margin-top:6px;"'+clickAttrs('go-new-farm')+'>+ Create another farm</button>'+
      '<button class="w-btn w-btn-ghost" style="width:100%;justify-content:center;margin-top:6px;"'+clickAttrs('logout')+'>Log out</button>'+
    '</div>';
  }
  function pickFarm(id){ var f = farms.find(function(x){return x.id===id;}); if(f) selectFarm(f); }
  function goNewFarm(){ appScreen='newfarm'; renderRoot(); }
  function viewNewFarm(){
    return '<div class="w-farmpick"><div class="w-authcard">'+
      '<h2 style="margin-bottom:4px;">Set up your farm</h2><div class="w-sub" style="margin-bottom:16px;color:var(--ink-muted);font-size:.82rem;">You\'ll be the farm manager and can invite others afterward.</div>'+
      '<form id="w-newfarm-form">'+
        '<div class="w-field"><label>Farm name</label><input name="name" required placeholder="e.g. Amara Rabbitry"/></div>'+
        '<div class="w-field"><label>Currency</label><select name="currency">'+CURRENCIES.map(function(c){return '<option value="'+c+'">'+c+'</option>';}).join('')+'</select></div>'+
        '<button type="submit" class="w-btn w-btn-primary" style="width:100%;justify-content:center;">Create farm</button>'+
      '</form>'+
      (farms.length? '<button class="w-btn w-btn-ghost" style="width:100%;justify-content:center;margin-top:8px;"'+clickAttrs('back-to-pick')+'>Back to my farms</button>' : '')+
    '</div></div>';
  }
  function backToPick(){ appScreen='pickfarm'; renderRoot(); }

  // ============ MAIN APP SHELL ============
  var VIEWS = [
    {id:'dashboard', label:'Dashboard', icon:'M3 11l9-8 9 8M5 10v10h14V10'},
    {id:'herd', label:'Herd', icon:'M4 20c0-4 4-6 8-6s8 2 8 6M12 12a4 4 0 100-8 4 4 0 000 8z'},
    {id:'breeding', label:'Breeding', icon:'M12 21s-7-4.5-9.5-9A5.5 5.5 0 0112 5a5.5 5.5 0 019.5 7c-2.5 4.5-9.5 9-9.5 9z'},
    {id:'health', label:'Health', icon:'M12 3v18M3 12h18'},
    {id:'housing', label:'Housing', icon:'M3 10l9-7 9 7v10H3z'},
    {id:'feed', label:'Feed', icon:'M6 3h12l1 4H5l1-4zM5 7l1.5 13a1 1 0 001 1h9a1 1 0 001-1L19 7M9 11h6M9 15h6'},
    {id:'ledger', label:'Ledger', icon:'M4 4h16v16H4zM4 9h16M9 9v11'},
    {id:'tasks', label:'Tasks', icon:'M5 13l4 4L19 7'},
    {id:'team', label:'Team', icon:'M17 20v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M13 8a4 4 0 11-8 0 4 4 0 018 0zM22 20v-1a3.5 3.5 0 00-2.7-3.4M16 4.2a3.5 3.5 0 010 6.7'}
  ];

  function viewApp(){
    return '<div class="warren-app">'+
      '<button class="w-hamburger"'+clickAttrs('open-menu')+' aria-label="Open navigation menu">☰</button>'+
      '<div class="w-sidebar" id="w-sidebar">'+
        '<div class="w-brand"><svg viewBox="0 0 24 24" fill="none" stroke="#8A3324" stroke-width="1.8" width="26" height="26"><path d="M8 10c-1-3-1-6 1-7 1.2 1 1.5 3.5 1 6M16 10c1-3 1-6-1-7-1.2 1-1.5 3.5-1 6"/><ellipse cx="12" cy="14" rx="6" ry="6.5"/><circle cx="10" cy="12.5" r=".6" fill="#8A3324"/><circle cx="14" cy="12.5" r=".6" fill="#8A3324"/></svg><div><h1>Warren</h1><span>Herd Ledger</span></div></div>'+
        '<div class="w-farmswitch">'+
          (farms.length>1? ('<select'+changeAttrs('switch-farm')+'>'+farms.map(function(f){return '<option value="'+f.id+'" '+(f.id===currentFarm.id?'selected':'')+'>'+esc(f.name)+'</option>';}).join('')+'</select>') : ('<div style="font-weight:600;font-size:.9rem;">'+esc(currentFarm.name)+'</div>'))+
          '<div class="role">'+esc(currentRole).replace('_',' ')+'</div>'+
        '</div>'+
        '<div class="w-nav" id="w-nav"></div>'+
        '<div class="w-sidefoot">'+esc(currentUser.displayName||currentUser.email)+'<br/>'+
          '<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('go-new-farm')+'>+ New farm</button> '+
          '<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('logout')+'>Log out</button>'+
        '</div>'+
      '</div>'+
      '<div class="w-main" id="w-main"></div>'+
      '<div class="w-mobile-overlay" id="w-mobile-overlay"'+clickAttrs('close-menu')+'></div>'+
    '</div>'+
    '<div id="w-modal-root"></div>';
  }
  async function switchFarm(id){ var f = farms.find(function(x){return x.id===id;}); if(f) await selectFarm(f); }

  function openMenu(){ var sidebar = document.getElementById('w-sidebar'); var overlay = document.getElementById('w-mobile-overlay'); if(sidebar) sidebar.classList.add('open'); if(overlay) overlay.classList.add('open'); }
  function closeMenu(){ var sidebar = document.getElementById('w-sidebar'); var overlay = document.getElementById('w-mobile-overlay'); if(sidebar) sidebar.classList.remove('open'); if(overlay) overlay.classList.remove('open'); }

  function renderNav(){
    var el = document.getElementById('w-nav'); if(!el) return;
    el.innerHTML = VIEWS.map(function(v){
      return '<button class="w-navitem '+(current===v.id?'active':'')+'"'+clickAttrs('go-view', {view:v.id})+'><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="'+v.icon+'"/></svg><span>'+v.label+'</span></button>';
    }).join('');
  }
  function go(view){ current = view; renderMain(); closeMenu(); }

  var taskFilter = {scope:'all', assignee:'all'};
  function taskStatusValue(t){ return String(t.status || 'active').toLowerCase(); }
  function taskDueValue(t){ return t.nextDue || t.dueDate || null; }
  function taskDueBucket(t){
    var due = taskDueValue(t);
    if(!due) return 3;
    var days = daysFromToday(due);
    if(days < 0) return 0;
    if(days === 0) return 1;
    return 2;
  }
  function taskStatusPill(status){
    var cls = status==='active' ? 'pill-moss' : (status==='paused' ? 'pill-warn' : 'pill-grey');
    return '<span class="w-pill '+cls+'">'+esc(status)+'</span>';
  }
  function setTaskFilter(key, value){ taskFilter[key]=value||'all'; if(current==='tasks') renderMain(); }
  function taskMemberOptions(selectedUid){
    var opts = ['<option value="">— Unassigned —</option>'];
    teamMembers.slice().sort(function(a,b){ return String(a.name||a.email||'').localeCompare(String(b.name||b.email||'')); }).forEach(function(m){
      opts.push('<option value="'+esc(m.uid)+'" '+(selectedUid===m.uid?'selected':'')+'>'+esc(m.name||m.email||m.uid)+'</option>');
    });
    return opts.join('');
  }
  function taskAssigneeLabel(t){
    if(t.assignedToName) return String(t.assignedToName);
    if(t.assignedToUid){
      var member = teamMembers.find(function(m){ return m.uid===t.assignedToUid; });
      if(member) return member.name || member.email || member.uid;
      return t.assignedToUid;
    }
    return 'Unassigned';
  }
  function taskVisibleByFilter(t){
    var scope = taskFilter.scope || 'all';
    var assignee = taskFilter.assignee || 'all';
    var status = taskStatusValue(t);
    var due = taskDueValue(t);
    var days = due ? daysFromToday(due) : 999;
    if(scope==='overdue' && !(days < 0 && status==='active')) return false;
    if(scope==='today' && !(days === 0 && status==='active')) return false;
    if(scope==='week' && !(days >= 0 && days <= 7 && status==='active')) return false;
    if(scope==='active' && status!=='active') return false;
    if(scope==='paused' && status!=='paused') return false;
    if(scope==='archived' && status!=='archived') return false;
    if(scope==='mine' && String(t.assignedToUid||'')!==String(currentUser && currentUser.uid || '')) return false;
    if(scope==='unassigned' && !!t.assignedToUid) return false;
    if(assignee!=='all'){
      if(assignee==='unassigned' && !!t.assignedToUid) return false;
      if(assignee!=='unassigned' && String(t.assignedToUid||'')!==String(assignee)) return false;
    }
    return true;
  }
  function taskFilterControls(){
    var dueOptions = [
      {value:'all', label:'All tasks'},
      {value:'overdue', label:'Overdue'},
      {value:'today', label:'Due today'},
      {value:'week', label:'Due in 7 days'},
      {value:'active', label:'Active'},
      {value:'paused', label:'Paused'},
      {value:'archived', label:'Archived'},
      {value:'mine', label:'Mine'},
      {value:'unassigned', label:'Unassigned'}
    ];
    var memberOptions = ['<option value="all">All assignees</option>','<option value="unassigned" '+(taskFilter.assignee==='unassigned'?'selected':'')+'>Unassigned</option>'];
    teamMembers.slice().sort(function(a,b){ return String(a.name||a.email||'').localeCompare(String(b.name||b.email||'')); }).forEach(function(m){
      memberOptions.push('<option value="'+esc(m.uid)+'" '+(taskFilter.assignee===m.uid?'selected':'')+'>'+esc(m.name||m.email||m.uid)+'</option>');
    });
    return '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">'+
      '<select'+changeAttrs('set-task-filter', {key:'scope'})+' style="padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--bg);">'+
      dueOptions.map(function(o){ return '<option value="'+o.value+'" '+(taskFilter.scope===o.value?'selected':'')+'>'+o.label+'</option>'; }).join('')+
      '</select>'+
      '<select'+changeAttrs('set-task-filter', {key:'assignee'})+' style="padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--bg);">'+memberOptions.join('')+'</select>'+
    '</div>';
  }
  function sortedTaskRows(rows){
    return rows.slice().sort(function(a,b){
      var sa = taskStatusValue(a), sb = taskStatusValue(b);
      var srA = sa==='active' ? 0 : (sa==='paused' ? 1 : 2);
      var srB = sb==='active' ? 0 : (sb==='paused' ? 1 : 2);
      if(srA !== srB) return srA - srB;
      var ba = taskDueBucket(a), bb = taskDueBucket(b);
      if(ba !== bb) return ba - bb;
      var da = taskDueValue(a) || '9999-12-31';
      var db = taskDueValue(b) || '9999-12-31';
      if(da !== db) return da.localeCompare(db);
      return String(a.name||'').localeCompare(String(b.name||''));
    });
  }
  function taskKpiStats(){
    var activeTasks = state.tasks.filter(function(t){ return taskStatusValue(t)==='active'; });
    var overdue = activeTasks.filter(function(t){ var due = taskDueValue(t); return due && daysFromToday(due) < 0; }).length;
    var dueToday = activeTasks.filter(function(t){ var due = taskDueValue(t); return due && daysFromToday(due) === 0; }).length;
    var start = new Date(todayStr()+'T00:00:00');
    start.setDate(start.getDate()-6);
    var completed7d = state.taskLogs.filter(function(log){
      if(!log.completedAt) return false;
      var d = new Date(String(log.completedAt)+'T00:00:00');
      return d >= start;
    }).length;
    return '<div class="w-stats">'+
      stat(activeTasks.length,'Active tasks')+
      stat(overdue,'Overdue')+
      stat(dueToday,'Due today')+
      stat(completed7d,'Completed (7 days)')+
    '</div>';
  }
  async function loadMembersForTasks(){
    if(teamMembers && teamMembers.length) return teamMembers;
    try{
      var snap = await db.collection('farms').doc(currentFarm.id).collection('members').get();
      teamMembers = snap.docs.map(function(d){ return Object.assign({uid:d.id}, d.data()); });
    }catch(e){ teamMembers = []; }
    return teamMembers;
  }
  function viewTasks(){
    if(!teamMembers.length){
      loadMembersForTasks().then(function(){ if(current==='tasks') renderMain(); });
    }
    var rows = sortedTaskRows(state.tasks.filter(taskVisibleByFilter));
    return '<div class="w-headrow"><div><h2>Tasks</h2><div class="w-sub">Record and schedule daily, weekly, and monthly activities.</div></div>'+ 
      (can('worker')?'<button class="w-btn w-btn-primary"'+clickAttrs('open-task-modal')+'>+ Add task</button>':'')+'</div>'+ 
      taskKpiStats()+
      '<div class="w-panel">'+taskFilterControls()+(rows.length? taskTable(rows) : '<div class="w-empty"><p>No tasks match this filter.</p></div>')+'</div>'+ 
      '<div class="w-panel"><h3>Recent task activity</h3>'+ taskLogsPanel() +'</div>';
  }

  function taskTable(rows){
    return '<table class="w-table"><thead><tr><th>Task</th><th>Status</th><th>Assignee</th><th>Frequency</th><th>Next due</th><th>Notes</th><th>Action</th></tr></thead><tbody>'+ 
      rows.map(function(t){
        var status = taskStatusValue(t);
        var due = taskDueValue(t);
        var dueText = due ? esc(due) : '—';
        return '<tr><td>'+esc(t.name)+'</td><td>'+taskStatusPill(status)+'</td><td>'+esc(taskAssigneeLabel(t))+'</td><td>'+esc(t.frequency)+'</td><td class="mono">'+dueText+'</td><td style="color:var(--ink-muted);">'+esc(t.notes||'')+'</td>'+ 
          '<td style="white-space:nowrap;">'+
            (can('worker') && status==='active' ? '<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('complete-task', {id:t.id})+'>Mark done</button> ' : '')+
            (can('worker')? '<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('open-task-modal', {id:t.id})+'>Edit</button>' : '—')+
          '</td></tr>';
      }).join('')+'</tbody></table>';
  }

  async function openTaskModal(id){
    await loadMembersForTasks();
    var t = id ? state.tasks.find(function(x){return x.id===id;}) : null;
    var html = '<div class="w-modal"><h3>'+(t?'Edit task':'Add task')+'</h3><form id="w-task-form">'+
      '<div class="w-row2"><div class="w-field"><label>Task name</label><input name="name" required value="'+esc(t?t.name:'')+'"/></div>'+ 
      '<div class="w-field"><label>Frequency</label><select name="frequency">'+
        ['daily','weekly','monthly'].map(function(freq){return '<option value="'+freq+'" '+(t&&t.frequency===freq?'selected':'')+'>'+freq.charAt(0).toUpperCase()+freq.slice(1)+'</option>';}).join('')+
      '</select></div></div>'+ 
      '<div class="w-row2"><div class="w-field"><label>Recurrence mode</label><select name="recurrenceMode">'+
        ['rolling','strict'].map(function(mode){ return '<option value="'+mode+'" '+((t&&t.recurrenceMode?t.recurrenceMode:'rolling')===mode?'selected':'')+'>'+mode.charAt(0).toUpperCase()+mode.slice(1)+'</option>'; }).join('')+
      '</select></div>'+ 
      '<div class="w-field"><label>Next due</label><input type="date" name="nextDue" value="'+esc(t?t.nextDue:'')+'"/></div></div>'+ 
      '<div class="w-row2"><div class="w-field"><label>Status</label><select name="status">'+
        ['active','paused','archived'].map(function(s){ return '<option value="'+s+'" '+((t?taskStatusValue(t):'active')===s?'selected':'')+'>'+s.charAt(0).toUpperCase()+s.slice(1)+'</option>'; }).join('')+
      '</select></div>'+ 
      '<div class="w-field"><label>Assignee</label><select name="assignedToUid">'+taskMemberOptions(t?t.assignedToUid:'')+'</select></div></div>'+ 
      '<div class="w-field"><label>Notes</label><input name="notes" value="'+esc(t?t.notes:'')+'"/></div>'+ 
      '<div class="w-modalfoot">'+(t&&can('supervisor')?'<button type="button" class="w-btn w-btn-danger"'+clickAttrs('delete-task', {id:t.id})+'>Delete</button>':'<span></span>')+ 
      '<span style="flex:1"></span><button type="button" class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Cancel</button>'+ 
      '<button type="submit" class="w-btn w-btn-primary">Save task</button></div></form></div>';
    showModal(html);
    document.getElementById('w-task-form').onsubmit = async function(e){
      e.preventDefault(); var f = new FormData(e.target);
      var body = {
        name:f.get('name'),
        frequency:f.get('frequency'),
        recurrenceMode:f.get('recurrenceMode') || 'rolling',
        status:f.get('status') || 'active',
        assignedToUid:f.get('assignedToUid')||null,
        nextDue:f.get('nextDue')||null,
        notes:f.get('notes')
      };
      try{ await saveTaskApi(t ? t.id : null, body); closeModal(); renderMain(); showToast('Task saved'); }
      catch(err){ showToast(friendlyError(err), true); }
    };
  }

  async function deleteTask(id){
    if(!confirm('Delete this task?')) return;
    try{ await deleteTaskApi(id); closeModal(); renderMain(); showToast('Task deleted'); }
    catch(err){ showToast(friendlyError(err), true); }
  }

  function taskLogsPanel(){
    var logs = state.taskLogs.slice().sort(function(a,b){
      return new Date(b.completedAt) - new Date(a.completedAt);
    }).slice(0,8);
    if(!logs.length) return '<div class="w-empty"><p>No task activity recorded yet.</p></div>';
    return '<table class="w-table"><thead><tr><th>Date</th><th>Task</th><th>By</th><th>Frequency</th><th>Notes</th><th>Attachment</th></tr></thead><tbody>'+
      logs.map(function(log){
        var attachment = log.attachmentUrl ? '<a href="'+esc(log.attachmentUrl)+'" target="_blank" rel="noopener noreferrer">Open</a>' : '—';
        return '<tr><td class="mono">'+fmtDate(log.completedAt)+'</td><td>'+esc(log.taskName)+'</td><td>'+esc(log.completedBy || '—')+'</td><td>'+esc(log.frequency)+'</td><td>'+esc(log.notes || '—')+'</td><td>'+attachment+'</td></tr>';
      }).join('')+'</tbody></table>';
  }

  function nextDueForFrequency(dateStr, frequency){
    var current = new Date((dateStr||todayStr())+'T00:00:00');
    if (frequency==='daily') current.setDate(current.getDate()+1);
    else if (frequency==='weekly') current.setDate(current.getDate()+7);
    else if (frequency==='monthly') current.setMonth(current.getMonth()+1);
    return current.toISOString().slice(0,10);
  }

  async function completeTask(id){
    var task = state.tasks.find(function(x){return x.id===id;});
    if(!task) return;
    try{
      var notes = prompt('Completion notes (optional):', '');
      if(notes === null) return;
      var attachmentUrl = prompt('Photo/attachment URL (optional):', '');
      if(attachmentUrl === null) return;
      await completeTaskApi(id, {notes:notes||'', attachmentUrl:attachmentUrl||''});
      renderMain();
      showToast('Task marked complete');
    }catch(err){ showToast(friendlyError(err), true); }
  }

  function renderMain(){
    renderNav();
    var main = document.getElementById('w-main'); if(!main) return;
    if(loading){ main.innerHTML = '<div class="w-loading">Loading herd ledger…</div>'; return; }
    if(current==='dashboard') main.innerHTML = viewDashboard();
    else if(current==='herd') main.innerHTML = viewHerd();
    else if(current==='breeding') main.innerHTML = viewBreeding();
    else if(current==='health') main.innerHTML = viewHealth();
    else if(current==='housing') main.innerHTML = viewHousing();
    else if(current==='feed') main.innerHTML = viewFeed();
    else if(current==='ledger') main.innerHTML = viewLedger();
    else if(current==='tasks') main.innerHTML = viewTasks();
    else if(current==='team') { main.innerHTML = '<div class="w-loading">Loading team…</div>'; loadAndRenderTeam(); }
  }
  function stat(n,l){ return '<div class="w-stat"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'; }

  // ============ DASHBOARD ============
  function viewDashboard(){
    var active = state.rabbits.filter(function(r){return r.status==='active';});
    var does = active.filter(function(r){return r.sex==='doe';}).length;
    var bucks = active.filter(function(r){return r.sex==='buck';}).length;
    var expecting = state.litters.filter(function(l){return !l.kindleDate;});
    var alerts = [];
    expecting.forEach(function(l){
      var days = daysFromToday(l.dueDate);
      if(days<=3){
        var doe = rabbitById(l.doeId);
        alerts.push('<div class="w-alert">🐇 <div><b>'+esc(doe?doe.tag:'?')+'</b> is due to kindle '+(days<0?('<b>'+Math.abs(days)+' days ago</b> — check nest box'):(days===0?'<b>today</b>':'in <b>'+days+' days</b>'))+' ('+fmtDate(l.dueDate)+')</div></div>');
      }
    });
    state.health.forEach(function(h){
      if(h.nextDue){
        var days = daysFromToday(h.nextDue);
        if(days<=7 && days>=0){
          var r = rabbitById(h.rabbitId);
          alerts.push('<div class="w-alert">💉 <div><b>'+esc(r?r.tag:'?')+'</b> — '+esc(h.type)+' due '+(days===0?'today':'in '+days+' days')+' ('+fmtDate(h.nextDue)+')</div></div>');
        }
      }
    });
    state.tasks.forEach(function(t){
      if(String(t.status||'active')!=='active') return;
      var due = t.nextDue || t.dueDate;
      if(!due) return;
      var days = daysFromToday(due);
      if(days<=0){
        alerts.push('<div class="w-alert">🗓️ <div><b>'+esc(t.name)+'</b> '+(days===0?'is due today':'is overdue by '+Math.abs(days)+' day'+(Math.abs(days)===1?'':'s'))+' ('+fmtDate(due)+')</div></div>');
      }
    });
    state.cages.forEach(function(c){
      var occ = active.filter(function(r){return r.cageId===c.id;}).length;
      if(occ>c.capacity) alerts.push('<div class="w-alert">🏠 <div>Hutch <b>'+esc(c.label)+'</b> is over capacity ('+occ+'/'+c.capacity+')</div></div>');
    });
    var lowStock = state.feedStock.filter(isLowStock);
    lowStock.forEach(function(f){ alerts.push('<div class="w-alert">🌾 <div><b>'+esc(f.name)+'</b> is low: '+f.quantity+' '+esc(f.unit)+' left (reorder at '+f.reorderLevel+')</div></div>'); });
    var dueTaskCount = state.tasks.filter(function(t){ if(String(t.status||'active')!=='active') return false; var due = t.nextDue || t.dueDate; return due && daysFromToday(due) <= 0; }).length;
    var overdueTaskCount = state.tasks.filter(function(t){ if(String(t.status||'active')!=='active') return false; var due = t.nextDue || t.dueDate; return due && daysFromToday(due) < 0; }).length;
    var lowStockCount = lowStock.length;
    var upcomingLitters = expecting.length;

    var actionButtons = '';
    if (can('worker')) actionButtons += '<button class="w-btn w-btn-primary w-quickaction"'+clickAttrs('open-rabbit-modal')+'>Add rabbit</button>';
    if (can('worker')) actionButtons += '<button class="w-btn w-btn-ghost w-quickaction"'+clickAttrs('open-task-modal')+'>Add task</button>';
    if (can('farm_manager')) actionButtons += '<button class="w-btn w-btn-ghost w-quickaction"'+clickAttrs('go-view', {view:'team'})+'>Manage team</button>';

    var emptyState = state.rabbits.length===0 ? ('<div class="w-panel w-empty"><p>Your herd ledger is empty. Add your first rabbit to get started.</p>'+(can('worker')?'<button class="w-btn w-btn-primary"'+clickAttrs('open-rabbit-modal')+'>+ Add a rabbit</button>':'')+'</div>') : '';

    return '<div class="w-panel w-hero"><div class="w-headrow"><div><h2>Dashboard</h2><div class="w-sub">'+esc(currentFarm.name)+' &middot; '+fmtDate(todayStr())+'</div></div></div>'+ 
      '<div class="w-hero-copy">Keep the farm running smoothly with one quick view of the most important updates. You have '+ dueTaskCount +' task'+(dueTaskCount===1?'':'s')+' due, with '+ overdueTaskCount +' overdue.</div>'+ 
      '<div class="w-dashboard-summary">'+
        '<div class="w-dashboard-card"><div class="title">Tasks due</div><div class="value">'+dueTaskCount+'</div><div class="meta">'+overdueTaskCount+' overdue</div></div>'+ 
        '<div class="w-dashboard-card"><div class="title">Low feed items</div><div class="value">'+lowStockCount+'</div><div class="meta">'+(lowStockCount?'Requires reorder':'All stocked')+'</div></div>'+ 
        '<div class="w-dashboard-card"><div class="title">Litters expecting</div><div class="value">'+upcomingLitters+'</div><div class="meta">'+(upcomingLitters?'Check due dates':'None scheduled')+'</div></div>'+ 
        '<div class="w-dashboard-card"><div class="title">Hutches</div><div class="value">'+state.cages.length+'</div><div class="meta">Capacity status below</div></div>'+ 
      '</div>'+ 
      (actionButtons? '<div class="w-quickactions">'+actionButtons+'</div>' : '')+
      '</div>'+
      emptyState+
      '<div class="w-stats">'+stat(active.length,'Active rabbits')+stat(does,'Does')+stat(bucks,'Bucks')+stat(expecting.length,'Litters expecting')+stat(state.cages.length,'Hutches')+stat(lowStock.length,'Low feed items')+stat(dueTaskCount,'Tasks due')+'</div>'+
      (alerts.length? ('<div class="w-panel"><h3>Attention needed</h3>'+alerts.join('')+'</div>') : '')+
      '<div class="w-panel"><h3>Recent activity</h3>'+recentActivity()+'</div>';
  }
  function recentActivity(){
    var items = [];
    state.rabbits.forEach(function(r){ items.push({d:r.dob||todayStr(), text:'Rabbit '+r.tag+' ('+r.name+') added to herd'}); });
    state.litters.forEach(function(l){ if(l.kindleDate){ var doe=rabbitById(l.doeId); items.push({d:l.kindleDate, text:(doe?doe.tag:'?')+' kindled '+(l.kitsBorn||0)+' kits'}); } });
    state.ledger.forEach(function(e){ items.push({d:e.date, text:e.type+': '+e.category+' — '+money(e.amount)}); });
    items.sort(function(a,b){ return new Date(b.d)-new Date(a.d); });
    items = items.slice(0,8);
    if(!items.length) return '<div class="w-empty"><p>Nothing recorded yet.</p></div>';
    return '<table class="w-table"><tbody>'+items.map(function(i){return '<tr><td class="mono" style="width:110px;color:var(--ink-muted);font-size:.76rem;">'+fmtDate(i.d)+'</td><td>'+esc(i.text)+'</td></tr>';}).join('')+'</tbody></table>';
  }

  // ============ HERD ============
  var herdFilter = {status:'all', sex:'all', q:''};
  function viewHerd(){
    var rows = state.rabbits.filter(function(r){
      if(herdFilter.status!=='all' && r.status!==herdFilter.status) return false;
      if(herdFilter.sex!=='all' && r.sex!==herdFilter.sex) return false;
      if(herdFilter.q && ((r.tag||'')+' '+(r.name||'')+' '+(r.breed||'')).toLowerCase().indexOf(herdFilter.q.toLowerCase())===-1) return false;
      return true;
    });
    return '<div class="w-headrow"><div><h2>Herd</h2><div class="w-sub">'+state.rabbits.length+' rabbits total</div></div>'+
      (can('worker')?'<button class="w-btn w-btn-primary"'+clickAttrs('open-rabbit-modal')+'>+ Add rabbit</button>':'')+'</div>'+
      '<div class="w-panel">'+
        '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">'+
          '<input placeholder="Search tag, name, breed…" value="'+esc(herdFilter.q)+'"'+inputAttrs('set-herd-filter', {key:'q'})+' style="flex:1;min-width:160px;padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--bg);"/>'+
          selectHtml('status', ['all','active','sold','retired','deceased'], herdFilter.status)+
          selectHtml('sex', ['all','doe','buck'], herdFilter.sex)+
        '</div>'+
        (rows.length? herdTable(rows) : '<div class="w-empty"><p>No rabbits match these filters.</p></div>')+
      '</div>';
  }
  function selectHtml(key, opts, val){
    return '<select'+changeAttrs('set-herd-filter', {key:key})+' style="padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--bg);">'+
      opts.map(function(o){return '<option value="'+o+'" '+(o===val?'selected':'')+'>'+(o==='all'?'All':o)+'</option>';}).join('')+
    '</select>';
  }
  function eartag(r){ return '<span class="eartag tag-'+(r.status||'active')+'">'+esc(r.tag)+'</span>'; }
  function statusPill(status){ var map={active:'pill-moss',sold:'pill-clay',deceased:'pill-grey',retired:'pill-warn'}; return '<span class="w-pill '+(map[status]||'pill-grey')+'">'+esc(status)+'</span>'; }
  function rabbitNameCell(r){
    if(!r) return '—';
    return '<span class="w-link"'+clickAttrs('open-rabbit-detail', {id:r.id})+'>'+esc(r.name)+'</span>';
  }
  function rabbitListLink(r, showName){
    if(!r) return '—';
    return '<span class="w-link"'+clickAttrs('open-rabbit-detail', {id:r.id})+'>'+eartag(r)+(showName ? ' '+esc(r.name) : '')+'</span>';
  }
  function kitsForLitter(litter){
    if(!litter || !litter.id) return [];
    var idMap = {};
    var out = [];
    state.rabbits.forEach(function(r){
      if(r.litterId === litter.id){
        idMap[r.id] = true;
        out.push(r);
      }
    });
    var linkedIds = Array.isArray(litter.kitIds) ? litter.kitIds : [];
    linkedIds.forEach(function(id){
      if(idMap[id]) return;
      var r = rabbitById(id);
      if(r){ idMap[id] = true; out.push(r); }
    });
    return out.sort(function(a,b){ return String(a.tag||'').localeCompare(String(b.tag||'')); });
  }
  function nextKitTag(seed, existing){
    var base = String(seed || 'KIT').replace(/[^A-Za-z0-9-]/g,'').toUpperCase() || 'KIT';
    var n = 1;
    var candidate = base+'-'+String(n).padStart(2,'0');
    while(existing[candidate]){
      n += 1;
      candidate = base+'-'+String(n).padStart(2,'0');
    }
    existing[candidate] = true;
    return candidate;
  }
  async function createKitRecordsForLitter(litterRow, createCount){
    if(!litterRow || !litterRow.id || !litterRow.kindleDate || !createCount || createCount < 1) return [];
    var doe = rabbitById(litterRow.doeId);
    var buck = rabbitById(litterRow.buckId);
    var existingTags = {};
    state.rabbits.forEach(function(r){ if(r.tag) existingTags[String(r.tag)] = true; });
    var seed = 'K'+String(litterRow.kindleDate||todayStr()).replace(/-/g,'');
    var created = [];
    for(var i=0;i<createCount;i++){
      var tag = nextKitTag(seed, existingTags);
      var body = {
        tag: tag,
        name: 'Kit '+String(i+1),
        breed: (doe && doe.breed) || (buck && buck.breed) || '',
        sex: 'unknown',
        dob: litterRow.kindleDate,
        status: 'active',
        sireId: litterRow.buckId || null,
        damId: litterRow.doeId || null,
        cageId: null,
        weight: null,
        purchasePrice: null,
        isKit: true,
        pictures: [],
        lineageHistory: '',
        litterId: litterRow.id,
        notes: 'Auto-generated from litter '+litterRow.id+' on '+todayStr()+'.'
      };
      created.push(await createItem('rabbits', body));
    }
    return created;
  }
  function pictureUrlsFromText(value){
    return String(value||'').split(/\n|,/).map(function(u){ return String(u||'').trim(); }).filter(Boolean);
  }
  function pictureUrlsToText(value){
    if(!value) return '';
    if(Array.isArray(value)) return value.join('\n');
    return String(value);
  }
  function moneyInput(n){ return (n===undefined || n===null || n==='') ? '' : String(n); }

  function herdTable(rows){
    return '<table class="w-table"><thead><tr><th>Tag</th><th>Name</th><th>Breed</th><th>Sex</th><th>DOB</th><th>Status</th><th>Hutch</th><th></th></tr></thead><tbody>'+
      rows.map(function(r){
        var cage = cageById(r.cageId);
        return '<tr><td>'+eartag(r)+'</td><td>'+rabbitNameCell(r)+(r.isKit?' <span class="w-pill pill-clay" style="margin-left:6px;">Kit</span>':'')+'</td>'+
          '<td>'+esc(r.breed)+'</td><td style="text-transform:capitalize;">'+esc(r.sex)+'</td>'+
          '<td class="mono" style="font-size:.78rem;">'+fmtDate(r.dob)+'</td><td>'+statusPill(r.status)+'</td>'+
          '<td>'+esc(cage?cage.label:'—')+'</td>'+
          '<td>'+(can('worker')?'<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('open-rabbit-modal', {id:r.id})+'>Edit</button>':'')+'</td></tr>';
      }).join('')+'</tbody></table>';
  }
  function rabbitOptions(selectedId, excludeId, sexFilter){
    var opts = state.rabbits.filter(function(r){ return r.id!==excludeId && (!sexFilter || r.sex===sexFilter); });
    return '<option value="">— none —</option>'+opts.map(function(r){return '<option value="'+r.id+'" '+(r.id===selectedId?'selected':'')+'>'+esc(r.tag)+' — '+esc(r.name)+'</option>';}).join('');
  }
  function cageOptions(selectedId, rabbit){
    var opts = state.cages.filter(function(c){ return !rabbit || rabbitMatchesHutchRule(rabbit, c); });
    return '<option value="">— unassigned —</option>'+opts.map(function(c){return '<option value="'+c.id+'" '+(c.id===selectedId?'selected':'')+'>'+esc(c.label)+'</option>';}).join('');
  }
  function hutchTypeLabel(v){
    if(v==='doe') return 'Doe';
    if(v==='buck') return 'Buck';
    if(v==='kits') return 'Kits';
    return 'Any';
  }
  function hutchTypeClass(v){
    if(v==='doe') return 'h-type-doe';
    if(v==='buck') return 'h-type-buck';
    if(v==='kits') return 'h-type-kits';
    return 'h-type-any';
  }
  function occupancyMeta(count, capacity){
    if(count===0) return {cls:'h-occ-empty', label:'Empty'};
    if(count>capacity) return {cls:'h-occ-over', label:'Over capacity'};
    var ratio = capacity>0 ? (count/capacity) : 1;
    if(ratio>=1) return {cls:'h-occ-full', label:'Full'};
    if(ratio>=0.8) return {cls:'h-occ-near', label:'Near full'};
    return {cls:'h-occ-good', label:'Healthy'};
  }
  function housingLegend(){
    return '<div class="w-panel h-legend" style="padding:12px 14px;margin-bottom:14px;">'+
      '<div class="h-legend-row"><span class="h-legend-title">Rabbit type</span>'+
      '<span class="h-chip h-type-chip h-type-any">Any</span>'+
      '<span class="h-chip h-type-chip h-type-doe">Doe</span>'+
      '<span class="h-chip h-type-chip h-type-buck">Buck</span>'+
      '<span class="h-chip h-type-chip h-type-kits">Kits</span></div>'+
      '<div class="h-legend-row"><span class="h-legend-title">Occupancy</span>'+
      '<span class="h-chip h-occ-chip h-occ-empty">Empty</span>'+
      '<span class="h-chip h-occ-chip h-occ-good">Healthy</span>'+
      '<span class="h-chip h-occ-chip h-occ-near">Near full</span>'+
      '<span class="h-chip h-occ-chip h-occ-full">Full</span>'+
      '<span class="h-chip h-occ-chip h-occ-over">Over capacity</span></div>'+
    '</div>';
  }
  function rabbitMatchesHutchRule(rabbit, hutch){
    if(!hutch) return true;
    var allowed = String(hutch.allowedSex || 'any');
    if(allowed === 'any') return true;
    if(allowed === 'kits') return !!rabbit.isKit;
    if(rabbit.isKit) return false;
    return rabbit.sex === allowed;
  }

  function openRabbitModal(id){
    var r = id ? rabbitById(id) : null;
    var nextTag = 'R-'+String(state.rabbits.length+1).padStart(3,'0');
    var picturesText = pictureUrlsToText(r && r.pictures);
    var draftRabbit = { sex:(r&&r.sex)||'doe', isKit:!!(r&&r.isKit) };
    var html = '<div class="w-modal"><h3>'+(r?'Edit rabbit':'Add rabbit')+'</h3><form id="w-rabbit-form">'+
      '<div class="w-row2"><div class="w-field"><label>Ear tag</label><input name="tag" required value="'+esc(r?r.tag:nextTag)+'"/></div>'+
      '<div class="w-field"><label>Name</label><input name="name" required value="'+esc(r?r.name:'')+'"/></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Breed</label><input name="breed" list="w-breeds" value="'+esc(r?r.breed:'')+'"/>'+
        '<datalist id="w-breeds"><option>New Zealand White</option><option>Californian</option><option>Flemish Giant</option><option>Rex</option><option>Dutch</option><option>Mini Lop</option><option>English Angora</option><option>Chinchilla</option></datalist></div>'+
      '<div class="w-field"><label>Sex</label><select name="sex"><option value="doe" '+(r&&r.sex==='doe'?'selected':'')+'>Doe (female)</option><option value="buck" '+(r&&r.sex==='buck'?'selected':'')+'>Buck (male)</option><option value="unknown" '+(r&&r.sex==='unknown'?'selected':'')+'>Unknown (unsexed kit)</option></select></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Purchase price ('+esc(currentFarm.currency)+')</label><input type="number" step="0.01" min="0" name="purchasePrice" value="'+esc(moneyInput(r&&r.purchasePrice))+'"/></div>'+
      '<div class="w-field"><label>Kit status</label><select name="isKit"><option value="no" '+(!r||!r.isKit?'selected':'')+'>Not a kit</option><option value="yes" '+(r&&r.isKit?'selected':'')+'>Kit</option></select></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Date of birth</label><input type="date" name="dob" value="'+esc(r?r.dob:'')+'"/></div>'+
      '<div class="w-field"><label>Status</label><select name="status"><option value="active" '+(!r||r.status==='active'?'selected':'')+'>Active</option><option value="retired" '+(r&&r.status==='retired'?'selected':'')+'>Retired</option><option value="sold" '+(r&&r.status==='sold'?'selected':'')+'>Sold</option><option value="deceased" '+(r&&r.status==='deceased'?'selected':'')+'>Deceased</option></select></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Sire (father)</label><select name="sireId">'+rabbitOptions(r?r.sireId:'', r?r.id:null,'buck')+'</select></div>'+
      '<div class="w-field"><label>Dam (mother)</label><select name="damId">'+rabbitOptions(r?r.damId:'', r?r.id:null,'doe')+'</select></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Hutch</label><select name="cageId">'+cageOptions(r?r.cageId:'', draftRabbit)+'</select></div>'+
      '<div class="w-field"><label>Weight (lb)</label><input type="number" step="0.1" name="weight" value="'+(r&&r.weight!=null?r.weight:'')+'"/></div></div>'+
      '<div class="w-field"><label>Pictures (URLs, one per line or comma separated)</label><textarea name="pictures" placeholder="https://...">'+esc(picturesText)+'</textarea></div>'+
      '<div class="w-field"><label>Lineage history</label><textarea name="lineageHistory" placeholder="Family line notes, notable traits, history">'+esc(r?r.lineageHistory:'')+'</textarea></div>'+
      '<div class="w-field"><label>Notes</label><textarea name="notes">'+esc(r?r.notes:'')+'</textarea></div>'+
      '<div class="w-modalfoot">'+(r&&can('supervisor')?'<button type="button" class="w-btn w-btn-danger"'+clickAttrs('delete-rabbit', {id:r.id})+'>Delete</button>':'<span></span>')+
      '<span style="flex:1"></span><button type="button" class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Cancel</button>'+
      '<button type="submit" class="w-btn w-btn-primary">Save rabbit</button></div></form></div>';
    showModal(html);
    var form = document.getElementById('w-rabbit-form');
    function refreshRabbitHutchOptions(){
      var selected = form.cageId.value;
      var draft = { sex: form.sex.value, isKit: form.isKit.value==='yes' };
      form.cageId.innerHTML = cageOptions(selected, draft);
      if(selected && !form.cageId.value) form.cageId.value = '';
    }
    form.sex.onchange = refreshRabbitHutchOptions;
    form.isKit.onchange = refreshRabbitHutchOptions;
    form.onsubmit = async function(e){
      e.preventDefault(); var f = new FormData(e.target);
      var body = {tag:f.get('tag'), name:f.get('name'), breed:f.get('breed'), sex:f.get('sex'), dob:f.get('dob')||null,
        status:f.get('status'), sireId:f.get('sireId')||null, damId:f.get('damId')||null, cageId:f.get('cageId')||null,
        weight:f.get('weight')?parseFloat(f.get('weight')):null,
        purchasePrice:f.get('purchasePrice')?parseFloat(f.get('purchasePrice')):null,
        isKit:f.get('isKit')==='yes',
        pictures:pictureUrlsFromText(f.get('pictures')),
        lineageHistory:f.get('lineageHistory')||'',
        notes:f.get('notes')};
      var selectedCage = body.cageId ? cageById(body.cageId) : null;
      if(selectedCage && !rabbitMatchesHutchRule(body, selectedCage)){
        showToast('Selected hutch is for '+hutchTypeLabel(selectedCage.allowedSex)+' rabbits. Choose a compatible hutch.', true);
        return;
      }
      try{ if(r) await updateItem('rabbits', r.id, body); else await createItem('rabbits', body); closeModal(); renderMain(); showToast('Rabbit saved'); }
      catch(err){ showToast(friendlyError(err), true); }
    };
  }
  async function deleteRabbit(id){
    if(!confirm('Remove this rabbit from the herd ledger? This cannot be undone.')) return;
    try{ await deleteItemApi('rabbits', id); closeModal(); renderMain(); showToast('Rabbit removed'); }
    catch(err){ showToast(friendlyError(err), true); }
  }
  function openRabbitDetail(id){
    var r = rabbitById(id); if(!r) return;
    var sire = r.sireId?rabbitById(r.sireId):null;
    var dam = r.damId?rabbitById(r.damId):null;
    var litter = r.litterId ? litterById(r.litterId) : null;
    var siblings = litter ? kitsForLitter(litter).filter(function(x){ return x.id !== r.id; }) : [];
    var cage = cageById(r.cageId);
    var pictures = Array.isArray(r.pictures) ? r.pictures : pictureUrlsFromText(r.pictures);
    var recs = state.health.filter(function(h){return h.rabbitId===id;}).sort(function(a,b){return new Date(b.date)-new Date(a.date);});
    var html = '<div class="w-modal" style="max-width:560px;">'+
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;"><h3>'+esc(r.name)+' '+eartag(r)+'</h3>'+statusPill(r.status)+'</div>'+
      '<div class="w-detailgrid" style="margin-top:12px;">'+det('Breed', r.breed)+det('Sex', r.sex)+det('Born', fmtDate(r.dob))+det('Kit status', r.isKit?'Kit':'Not a kit')+det('Purchase price', r.purchasePrice!=null?money(r.purchasePrice):'—')+det('Weight', r.weight?r.weight+' lb':'—')+det('Hutch', cage?cage.label:'Unassigned')+det('Sire', sire?sire.tag+' — '+sire.name:'Unknown')+det('Dam', dam?dam.tag+' — '+dam.name:'Unknown')+'</div>'+
      (litter ? ('<div style="margin-top:8px;"><b>Birth litter:</b> <span class="w-link"'+clickAttrs('open-litter-modal', {id:litter.id})+'>Open litter record</span>'+(siblings.length?('<div class="w-sub" style="margin-top:4px;">Siblings: '+siblings.map(function(s){ return rabbitListLink(s, true); }).join(' ')+'</div>'):'')+'</div>') : '')+
      (sire||dam? ('<div style="margin-top:6px;padding-top:10px;border-top:1px solid var(--line);"><div class="k" style="font-size:.72rem;text-transform:uppercase;color:var(--ink-muted);letter-spacing:.5px;margin-bottom:6px;">Grandparents</div><div class="w-detailgrid">'+det("Sire's sire", grand(sire,'sireId'))+det("Sire's dam", grand(sire,'damId'))+det("Dam's sire", grand(dam,'sireId'))+det("Dam's dam", grand(dam,'damId'))+'</div></div>') : '')+
      (r.lineageHistory? '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line);"><div class="k" style="font-size:.72rem;text-transform:uppercase;color:var(--ink-muted);letter-spacing:.5px;margin-bottom:6px;">Lineage history</div><div style="font-size:.85rem;color:var(--ink-muted);line-height:1.5;">'+esc(r.lineageHistory).replace(/\n/g,'<br/>')+'</div></div>':'')+
      (pictures.length? '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line);"><div class="k" style="font-size:.72rem;text-transform:uppercase;color:var(--ink-muted);letter-spacing:.5px;margin-bottom:8px;">Pictures</div><div class="w-rabbit-gallery">'+pictures.map(function(url){ return '<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer"><img src="'+esc(url)+'" alt="'+esc(r.name)+' picture" loading="lazy"/></a>'; }).join('')+'</div></div>' : '')+
      (r.notes? '<div style="margin-top:10px;font-size:.85rem;color:var(--ink-muted);"><em>'+esc(r.notes)+'</em></div>':'')+
      '<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--line);"><div class="k" style="font-size:.72rem;text-transform:uppercase;color:var(--ink-muted);letter-spacing:.5px;margin-bottom:6px;">Health history</div>'+
      (recs.length? recs.map(function(h){return '<div style="font-size:.82rem;padding:4px 0;">'+fmtDate(h.date)+' — <b>'+esc(h.type)+'</b> '+esc(h.description||'')+'</div>';}).join('') : '<div style="font-size:.82rem;color:var(--ink-muted);">No health records yet.</div>')+'</div>'+
      '<div class="w-modalfoot"><button class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Close</button>'+(can('worker')?'<button class="w-btn w-btn-ghost"'+clickAttrs('open-ledger-modal', {rabbitId:r.id, prefillType:'Sale', prefillCategory:'Rabbit sale'})+'>Log sale</button><button class="w-btn w-btn-primary"'+clickAttrs('edit-rabbit-from-detail', {id:r.id})+'>Edit</button>':'')+'</div>'+
    '</div>';
    showModal(html);
  }
  function det(k,v){ return '<div><div class="k">'+k+'</div><div>'+esc(v)+'</div></div>'; }
  function grand(parent, key){ if(!parent || !parent[key]) return 'Unknown'; var g = rabbitById(parent[key]); return g ? g.tag+' — '+g.name : 'Unknown'; }

  // ============ BREEDING ============
  var breedingRange = 'all';
  var breedingCustomStart = '';
  var breedingCustomEnd = '';
  function setBreedingRange(v){ breedingRange = v || 'all'; if(current==='breeding') renderMain(); }
  function setBreedingCustomDate(kind, value){
    if(kind === 'start') breedingCustomStart = value || '';
    if(kind === 'end') breedingCustomEnd = value || '';
  }
  function applyBreedingCustomRange(){
    breedingRange = 'custom';
    if(current==='breeding') renderMain();
  }
  function resetBreedingCustomRange(){
    breedingRange = 'all';
    breedingCustomStart = '';
    breedingCustomEnd = '';
    if(current==='breeding') renderMain();
  }
  function litterKeyDate(l){
    return l.matingDate || l.kindleDate || l.weanDate || null;
  }
  function filterBreedingRows(rows){
    if(breedingRange === 'all') return rows;
    if(breedingRange === 'custom'){
      var start = breedingCustomStart ? new Date(breedingCustomStart+'T00:00:00') : null;
      var end = breedingCustomEnd ? new Date(breedingCustomEnd+'T23:59:59') : null;
      if(!start && !end) return rows;
      return rows.filter(function(l){
        var keyDate = litterKeyDate(l);
        if(!keyDate) return false;
        var d = new Date(keyDate+'T12:00:00');
        if(start && d < start) return false;
        if(end && d > end) return false;
        return true;
      });
    }
    var days = parseInt(breedingRange, 10);
    if(!days || isNaN(days)) return rows;
    var start = new Date(todayStr()+'T00:00:00');
    start.setDate(start.getDate()-days);
    return rows.filter(function(l){
      var keyDate = litterKeyDate(l);
      if(!keyDate) return false;
      var d = new Date(keyDate+'T00:00:00');
      return d >= start;
    });
  }
  function breedingRangeSelect(){
    var opts = [
      {value:'all', label:'All records'},
      {value:'30', label:'Last 30 days'},
      {value:'90', label:'Last 90 days'},
      {value:'180', label:'Last 180 days'},
      {value:'custom', label:'Custom range'}
    ];
    return '<select'+changeAttrs('set-breeding-range')+' style="padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--bg);">'+
      opts.map(function(o){ return '<option value="'+o.value+'" '+(o.value===breedingRange?'selected':'')+'>'+o.label+'</option>'; }).join('')+
    '</select>';
  }
  function breedingRangeCustomControls(){
    if(breedingRange !== 'custom') return '';
    return '<div style="display:flex;align-items:end;gap:8px;flex-wrap:wrap;">'+
      '<div class="w-field" style="margin:0;"><label>From</label><input type="date" value="'+esc(breedingCustomStart)+'"'+changeAttrs('set-breeding-custom-start')+' style="padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--bg);"/></div>'+
      '<div class="w-field" style="margin:0;"><label>To</label><input type="date" value="'+esc(breedingCustomEnd)+'"'+changeAttrs('set-breeding-custom-end')+' style="padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--bg);"/></div>'+
      '<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('apply-breeding-custom-range')+'>Apply</button>'+
      '<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('reset-breeding-custom-range')+'>Clear</button>'+
    '</div>';
  }
  function breedingFilterSummary(){
    if(breedingRange === 'all') return 'All records';
    if(breedingRange === 'custom'){
      if(breedingCustomStart && breedingCustomEnd) return 'Custom: '+breedingCustomStart+' to '+breedingCustomEnd;
      if(breedingCustomStart) return 'Custom: from '+breedingCustomStart;
      if(breedingCustomEnd) return 'Custom: until '+breedingCustomEnd;
      return 'Custom: all dates';
    }
    return 'Last '+breedingRange+' days';
  }
  function csvCell(v){
    var s = v===undefined || v===null ? '' : String(v);
    return '"'+s.replace(/"/g,'""')+'"';
  }
  function downloadCsv(filename, rows){
    var csv = rows.map(function(row){ return row.map(csvCell).join(','); }).join('\n');
    var blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
  function exportBreedingRecordsCsv(){
    var allRows = state.litters.slice().sort(function(a,b){return new Date(b.matingDate)-new Date(a.matingDate);});
    var rows = filterBreedingRows(allRows);
    if(!rows.length){ showToast('No breeding records in current filter.', true); return; }
    var table = [
      ['Filter scope', breedingFilterSummary()],
      ['Doe tag','Doe name','Buck tag','Buck name','Mating date','Palpation date','Due date','Kindle date','Wean date','Kits born','Kits alive','Status','Mating notes','Kindling notes','Fostered in','Fostered out','Mortality reasons','Weaning outcome','Notes']
    ];
    rows.forEach(function(l){
      var doe = rabbitById(l.doeId);
      var buck = rabbitById(l.buckId);
      var st = litterStatus(l);
      table.push([
        doe ? (doe.tag || '') : '',
        doe ? (doe.name || '') : '',
        buck ? (buck.tag || '') : '',
        buck ? (buck.name || '') : '',
        l.matingDate || '',
        l.palpationDate || '',
        l.dueDate || (l.matingDate ? addDays(l.matingDate, GEST_DAYS) : ''),
        l.kindleDate || '',
        l.weanDate || '',
        l.kitsBorn!=null ? l.kitsBorn : '',
        l.kitsAlive!=null ? l.kitsAlive : '',
        st.label,
        l.matingNotes || '',
        l.kindlingNotes || '',
        l.fosterInCount!=null ? l.fosterInCount : '',
        l.fosterOutCount!=null ? l.fosterOutCount : '',
        l.mortalityReasons || '',
        l.weaningOutcome || '',
        l.notes || ''
      ]);
    });
    downloadCsv('breeding-records-'+todayStr()+'.csv', table);
    showToast('Breeding records CSV downloaded.');
  }
  function exportBreedingQueueCsv(){
    var allRows = state.litters.slice().sort(function(a,b){return new Date(b.matingDate)-new Date(a.matingDate);});
    var rows = filterBreedingRows(allRows);
    var queue = breedingActionQueue(rows);
    if(!queue.length){ showToast('No queue items in current filter.', true); return; }
    var table = [
      ['Filter scope', breedingFilterSummary()],
      ['Pair','Action','Stage','Date','Days offset','Due text']
    ];
    queue.forEach(function(item){
      table.push([
        item.pair,
        item.label,
        item.stage,
        item.date,
        item.days,
        queueDueText(item)
      ]);
    });
    downloadCsv('breeding-queue-'+todayStr()+'.csv', table);
    showToast('Breeding queue CSV downloaded.');
  }
  function viewBreeding(){
    var allRows = state.litters.slice().sort(function(a,b){return new Date(b.matingDate)-new Date(a.matingDate);});
    var rows = filterBreedingRows(allRows);
    var queue = breedingActionQueue(rows);
    var metrics = breedingMetrics(rows);
    var overdueCount = queue.filter(function(q){ return q.days < 0; }).length;
    var dueTodayCount = queue.filter(function(q){ return q.days === 0; }).length;
    var upcomingCount = queue.filter(function(q){ return q.days > 0 && q.days <= 14; }).length;
    return '<div class="w-headrow"><div><h2>Breeding</h2><div class="w-sub">'+rows.length+' records in view ('+allRows.length+' total)</div></div>'+
      (can('worker')?'<button class="w-btn w-btn-primary"'+clickAttrs('open-litter-modal')+'>+ Record pairing</button>':'')+'</div>'+
      '<div class="w-panel" style="padding:12px 14px;margin-bottom:14px;">'+
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:space-between;">'+
          '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;"><span style="font-size:.78rem;color:var(--ink-muted);text-transform:uppercase;letter-spacing:.45px;font-weight:700;">Date range</span>'+breedingRangeSelect()+breedingRangeCustomControls()+'</div>'+
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">'+
            '<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('export-breeding-records-csv')+'>Export records CSV</button>'+
            '<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('export-breeding-queue-csv')+'>Export queue CSV</button>'+
          '</div>'+
        '</div>'+
        '<div class="w-sub" style="margin-top:8px;">Active filter: '+esc(breedingFilterSummary())+'</div>'+
      '</div>'+
      '<div class="w-stats">'+stat(overdueCount,'Overdue milestones')+stat(dueTodayCount,'Due today')+stat(upcomingCount,'Next 14 days')+'</div>'+ 
      '<div class="w-panel">'+breedingAnalyticsPanel(metrics)+'</div>'+ 
      '<div class="w-panel">'+breedingQueuePanel(queue)+'</div>'+
      '<div class="w-panel">'+(rows.length? breedingTimeline(rows) : '<div class="w-empty"><p>No breedings recorded yet.</p></div>')+'</div>';
  }
  function pct(n, d){ return d>0 ? (Math.round((n/d)*1000)/10).toFixed(1)+'%' : '—'; }
  function pctNum(n, d){ return d>0 ? ((n/d)*100) : null; }
  function avg(arr){ return arr.length ? (arr.reduce(function(s,v){ return s+v; },0)/arr.length) : null; }
  function breedingMetrics(rows){
    var mated = rows.filter(function(l){ return !!l.matingDate; });
    var kindled = rows.filter(function(l){ return !!l.kindleDate; });
    var weaned = rows.filter(function(l){ return !!l.weanDate; });

    var bornTotals = rows.reduce(function(acc,l){
      if(l.kitsBorn!=null){ acc.born += Number(l.kitsBorn)||0; }
      if(l.kitsAlive!=null){ acc.alive += Number(l.kitsAlive)||0; }
      return acc;
    }, {born:0, alive:0});

    var does = {};
    var bucks = {};
    var pairings = {};

    function pairKey(doeId, buckId){ return String(doeId||'')+'::'+String(buckId||''); }

    rows.forEach(function(l){
      if(l.doeId){
        if(!does[l.doeId]) does[l.doeId] = {id:l.doeId, pairings:0, kindled:0, weanedLitters:0, kitsAlive:0, kitsWeaned:0, matingDates:[]};
        does[l.doeId].pairings += 1;
        if(l.matingDate) does[l.doeId].matingDates.push(l.matingDate);
        if(l.kindleDate) does[l.doeId].kindled += 1;
        if(l.weanDate) does[l.doeId].weanedLitters += 1;
        if(l.kitsAlive!=null) does[l.doeId].kitsAlive += Number(l.kitsAlive)||0;
        if(l.weanDate){
          does[l.doeId].kitsWeaned += Number(l.kitsAlive!=null ? l.kitsAlive : (l.kitsBorn!=null ? l.kitsBorn : 0))||0;
        }
      }
      if(l.buckId){
        if(!bucks[l.buckId]) bucks[l.buckId] = {id:l.buckId, pairings:0, kindled:0, weanedLitters:0, kitsAlive:0, kitsWeaned:0};
        bucks[l.buckId].pairings += 1;
        if(l.kindleDate) bucks[l.buckId].kindled += 1;
        if(l.weanDate) bucks[l.buckId].weanedLitters += 1;
        if(l.kitsAlive!=null) bucks[l.buckId].kitsAlive += Number(l.kitsAlive)||0;
        if(l.weanDate){
          bucks[l.buckId].kitsWeaned += Number(l.kitsAlive!=null ? l.kitsAlive : (l.kitsBorn!=null ? l.kitsBorn : 0))||0;
        }
      }

      if(l.doeId && l.buckId){
        var k = pairKey(l.doeId, l.buckId);
        if(!pairings[k]) pairings[k] = {
          doeId:l.doeId,
          buckId:l.buckId,
          pairings:0,
          kindled:0,
          weanedLitters:0,
          kitsBorn:0,
          kitsAlive:0,
          kitsWeaned:0,
          matingDates:[]
        };
        pairings[k].pairings += 1;
        if(l.matingDate) pairings[k].matingDates.push(l.matingDate);
        if(l.kindleDate) pairings[k].kindled += 1;
        if(l.weanDate) pairings[k].weanedLitters += 1;
        if(l.kitsBorn!=null) pairings[k].kitsBorn += Number(l.kitsBorn)||0;
        if(l.kitsAlive!=null) pairings[k].kitsAlive += Number(l.kitsAlive)||0;
        if(l.weanDate){
          pairings[k].kitsWeaned += Number(l.kitsAlive!=null ? l.kitsAlive : (l.kitsBorn!=null ? l.kitsBorn : 0))||0;
        }
      }
    });

    var doeIntervals = [];
    Object.keys(does).forEach(function(id){
      var d = does[id];
      var dates = d.matingDates.map(function(x){ return new Date(x+'T00:00:00'); }).sort(function(a,b){ return a-b; });
      for(var i=1;i<dates.length;i++){
        var delta = Math.round((dates[i]-dates[i-1])/86400000);
        if(delta>=0) doeIntervals.push(delta);
      }
    });

    function avgIntervalDaysFromDates(list){
      var dates = list.map(function(x){ return new Date(x+'T00:00:00'); }).sort(function(a,b){ return a-b; });
      if(dates.length < 2) return null;
      var gaps = [];
      for(var i=1;i<dates.length;i++){
        var delta = Math.round((dates[i]-dates[i-1])/86400000);
        if(delta >= 0) gaps.push(delta);
      }
      return avg(gaps);
    }

    function scoreEntries(map, includeInterval){
      return Object.keys(map).map(function(id){
        var it = map[id];
        var rabbit = rabbitById(id);
        var name = rabbit ? (rabbit.tag+' — '+rabbit.name) : id;
        var conceptionRateNum = pctNum(it.kindled, it.pairings);
        var weanedRateNum = pctNum(it.weanedLitters, it.kindled);
        var avgWeanedPerCycle = it.pairings>0 ? (it.kitsWeaned / it.pairings) : 0;
        return {
          id:id,
          name:name,
          pairings:it.pairings,
          kindled:it.kindled,
          conceptionRateNum:conceptionRateNum,
          conceptionRate: conceptionRateNum==null ? '—' : (Math.round(conceptionRateNum*10)/10).toFixed(1)+'%',
          weanedRateNum:weanedRateNum,
          weanedRate: weanedRateNum==null ? '—' : (Math.round(weanedRateNum*10)/10).toFixed(1)+'%',
          avgWeanedPerCycle:avgWeanedPerCycle,
          avgIntervalDays: includeInterval ? avgIntervalDaysFromDates(it.matingDates || []) : null
        };
      }).filter(function(it){
        return it.kindled >= BREED_RANK_MIN_KINDLED;
      }).sort(function(a,b){
        if(b.avgWeanedPerCycle!==a.avgWeanedPerCycle) return b.avgWeanedPerCycle-a.avgWeanedPerCycle;
        return b.kindled-a.kindled;
      });
    }

    var pairingRows = Object.keys(pairings).map(function(k){
      var it = pairings[k];
      var doe = rabbitById(it.doeId);
      var buck = rabbitById(it.buckId);
      var conceptionRateNum = pctNum(it.kindled, it.pairings);
      var bornAliveRateNum = pctNum(it.kitsAlive, it.kitsBorn);
      var weanedRateNum = pctNum(it.weanedLitters, it.kindled);
      var avgWeanedPerCycle = it.pairings>0 ? (it.kitsWeaned / it.pairings) : 0;
      var avgIntervalDays = avgIntervalDaysFromDates(it.matingDates);
      return {
        key:k,
        doeName: doe ? (doe.tag+' — '+doe.name) : it.doeId,
        buckName: buck ? (buck.tag+' — '+buck.name) : it.buckId,
        pairLabel: (doe ? doe.tag : '?')+' × '+(buck ? buck.tag : '?'),
        pairings:it.pairings,
        kindled:it.kindled,
        weanedLitters:it.weanedLitters,
        conceptionRateNum:conceptionRateNum,
        conceptionRate: conceptionRateNum==null ? '—' : (Math.round(conceptionRateNum*10)/10).toFixed(1)+'%',
        bornAliveRateNum:bornAliveRateNum,
        bornAliveRate: bornAliveRateNum==null ? '—' : (Math.round(bornAliveRateNum*10)/10).toFixed(1)+'%',
        weanedRateNum:weanedRateNum,
        weanedRate: weanedRateNum==null ? '—' : (Math.round(weanedRateNum*10)/10).toFixed(1)+'%',
        avgWeanedPerCycle:avgWeanedPerCycle,
        avgIntervalDays:avgIntervalDays
      };
    }).sort(function(a,b){
      if(b.avgWeanedPerCycle!==a.avgWeanedPerCycle) return b.avgWeanedPerCycle-a.avgWeanedPerCycle;
      if((b.conceptionRateNum||0)!==(a.conceptionRateNum||0)) return (b.conceptionRateNum||0)-(a.conceptionRateNum||0);
      return b.pairings-a.pairings;
    });

    return {
      totalPairings: rows.length,
      matedCount: mated.length,
      kindledCount: kindled.length,
      weanedCount: weaned.length,
      conceptionRate: pct(kindled.length, mated.length),
      weaningCompletionRate: pct(weaned.length, kindled.length),
      survivalRate: pct(bornTotals.alive, bornTotals.born),
      avgKitsAlive: kindled.length ? (bornTotals.alive / kindled.length) : null,
      avgDoeInterval: avg(doeIntervals),
      rankMinKindled: BREED_RANK_MIN_KINDLED,
      pairingRows: pairingRows,
      topDoes: scoreEntries(does, true).slice(0,5),
      topBucks: scoreEntries(bucks, false).slice(0,5)
    };
  }
  function breedingTopPanel(title, rows, minKindled, showInterval){
    if(!rows.length) return '<div class="w-empty" style="padding:12px 0;"><p>No data yet (min '+minKindled+' kindled litters).</p></div>';
    return '<div class="b-rank-block"><h4>'+esc(title)+'</h4><table class="w-table"><thead><tr><th>Rabbit</th><th>Cycles</th><th>Conception</th><th>Weaned %</th><th>Avg kits weaned/cycle</th>'+(showInterval?'<th>Interval</th>':'')+'</tr></thead><tbody>'+rows.map(function(r){
      return '<tr><td>'+esc(r.name)+'</td><td class="mono">'+r.pairings+'</td><td class="mono">'+r.conceptionRate+'</td><td class="mono">'+r.weanedRate+'</td><td class="mono">'+(Math.round(r.avgWeanedPerCycle*10)/10).toFixed(1)+'</td>'+(showInterval?'<td class="mono">'+(r.avgIntervalDays!=null?Math.round(r.avgIntervalDays)+'d':'—')+'</td>':'')+'</tr>';
    }).join('')+'</tbody></table></div>';
  }
  function breedingPairingPerformanceTable(rows){
    if(!rows.length) return '<div class="w-empty" style="padding:12px 0;"><p>No pairing data yet.</p></div>';
    return '<div class="b-rank-block"><h4>Pairing performance</h4><table class="w-table"><thead><tr><th>Pairing</th><th>Cycles</th><th>Conception rate</th><th>Born alive %</th><th>Weaned %</th><th>Avg kits weaned / cycle</th><th>Interval between litters</th></tr></thead><tbody>'+rows.map(function(r){
      return '<tr><td>'+esc(r.pairLabel)+'</td><td class="mono">'+r.pairings+'</td><td class="mono">'+r.conceptionRate+'</td><td class="mono">'+r.bornAliveRate+'</td><td class="mono">'+r.weanedRate+'</td><td class="mono">'+(Math.round(r.avgWeanedPerCycle*10)/10).toFixed(1)+'</td><td class="mono">'+(r.avgIntervalDays!=null?Math.round(r.avgIntervalDays)+' days':'—')+'</td></tr>';
    }).join('')+'</tbody></table></div>';
  }
  function breedingAnalyticsPanel(m){
    return '<h3>Breeding analytics</h3><div class="w-sub" style="margin-bottom:10px;">Rankings include rabbits with at least '+m.rankMinKindled+' kindled litters.</div>'+ 
      '<div class="w-stats">'+
        stat(m.totalPairings,'Total pairings')+
        stat(m.conceptionRate,'Conception rate')+
        stat(m.survivalRate,'Born-to-alive rate')+
        stat(m.weaningCompletionRate,'Weaning completion')+
        stat(m.avgKitsAlive!=null?(Math.round(m.avgKitsAlive*10)/10).toFixed(1):'—','Avg kits alive / kindled litter')+
        stat(m.avgDoeInterval!=null?Math.round(m.avgDoeInterval)+' days':'—','Avg doe interval')+
      '</div>'+
      '<div style="margin-top:12px;">'+breedingPairingPerformanceTable(m.pairingRows)+'</div>'+
      '<div class="b-rank-grid">'+
        breedingTopPanel('Top does', m.topDoes, m.rankMinKindled, true)+
        breedingTopPanel('Top bucks', m.topBucks, m.rankMinKindled, false)+
      '</div>';
  }
  function breedingActionQueue(rows){
    var items = [];
    rows.forEach(function(l){
      var doe = rabbitById(l.doeId), buck = rabbitById(l.buckId);
      var pairText = (doe?doe.tag:'?')+' × '+(buck?buck.tag:'?');
      var matingDate = l.matingDate || null;
      var palpationTarget = matingDate ? addDays(matingDate, PALPATION_DAYS) : null;
      var dueDate = l.dueDate || (matingDate ? addDays(matingDate, GEST_DAYS) : null);
      var nestPrepTarget = dueDate ? addDays(dueDate, -3) : null;
      var weanTarget = l.kindleDate ? addDays(l.kindleDate, WEAN_TARGET_DAYS) : null;

      function pushIf(date, label, stage){
        if(!date) return;
        var days = daysFromToday(date);
        if(days > 14) return;
        items.push({
          litterId:l.id,
          pair:pairText,
          label:label,
          stage:stage,
          date:date,
          days:days
        });
      }

      if(matingDate && !l.palpationDate) pushIf(palpationTarget, 'Palpation check', 'palpation');
      if(dueDate && !l.kindleDate){
        pushIf(nestPrepTarget, 'Nest box prep', 'nest-prep');
        pushIf(dueDate, 'Kindling due', 'due');
      }
      if(weanTarget && !l.weanDate) pushIf(weanTarget, 'Weaning due', 'wean');
    });
    items.sort(function(a,b){ return new Date(a.date) - new Date(b.date); });
    return items;
  }
  function queueBadge(item){
    if(item.days < 0) return '<span class="b-queue-badge over">Overdue</span>';
    if(item.days === 0) return '<span class="b-queue-badge today">Today</span>';
    if(item.days <= 3) return '<span class="b-queue-badge soon">Soon</span>';
    return '<span class="b-queue-badge plan">Planned</span>';
  }
  function queueDueText(item){
    if(item.days < 0) return Math.abs(item.days)+' day(s) late';
    if(item.days === 0) return 'Due today';
    return 'In '+item.days+' day(s)';
  }
  function breedingQueuePanel(queue){
    if(!queue.length) return '<div class="w-empty" style="padding:14px 6px;"><p>No breeding actions due in the next 14 days.</p></div>';
    return '<div class="b-queue-list">'+queue.map(function(item){
      return '<div class="b-queue-item'+(item.days<0?' overdue':'')+'">'+
        '<div class="b-queue-main"><div class="b-queue-title">'+esc(item.label)+' · '+esc(item.pair)+'</div>'+
        '<div class="b-queue-meta mono">'+fmtDate(item.date)+' · '+esc(queueDueText(item))+'</div></div>'+
        '<div class="b-queue-side">'+queueBadge(item)+(can('worker')?'<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('open-litter-modal', {id:item.litterId})+'>Open</button>':'')+'</div>'+
      '</div>';
    }).join('')+'</div>';
  }
  function litterStatus(l){
    var dueDate = l.dueDate || (l.matingDate ? addDays(l.matingDate, GEST_DAYS) : null);
    if(l.weanDate) return {label:'Closed',cls:'pill-moss'};
    if(l.kindleDate) return {label:'Weaning pending',cls:'pill-clay'};
    if(dueDate && daysFromToday(dueDate) < 0) return {label:'Kindling overdue',cls:'pill-warn'};
    if(l.palpationDate) return {label:'Awaiting kindling',cls:'pill-grey'};
    if(l.matingDate) return {label:'Awaiting palpation',cls:'pill-grey'};
    return {label:'Planned',cls:'pill-grey'};
  }
  function breedingDetailLine(label, value){
    if(value===undefined || value===null || value==='') return '';
    return '<div class="b-detail-row"><b>'+esc(label)+':</b> '+esc(value)+'</div>';
  }
  function breedingDetailLineCount(label, value){
    if(value===undefined || value===null || value==='') return '';
    return '<div class="b-detail-row"><b>'+esc(label)+':</b> '+Number(value)+'</div>';
  }
  function breedingOutcomeChip(label, value, cls){
    if(value===undefined || value===null || value==='') return '';
    return '<span class="b-outcome-chip '+cls+'"><b>'+esc(label)+':</b> '+esc(value)+'</span>';
  }
  function breedingOutcomeSummary(l){
    var chips = [];
    if(Number(l.fosterInCount||0) > 0) chips.push(breedingOutcomeChip('Foster in', Number(l.fosterInCount), 'b-outcome-info'));
    if(Number(l.fosterOutCount||0) > 0) chips.push(breedingOutcomeChip('Foster out', Number(l.fosterOutCount), 'b-outcome-info'));
    if((l.mortalityReasons||'').trim()) chips.push(breedingOutcomeChip('Mortality', 'Noted', 'b-outcome-warn'));
    if((l.weaningOutcome||'').trim()) chips.push(breedingOutcomeChip('Weaning', l.weaningOutcome, 'b-outcome-good'));
    return chips.length ? '<div class="b-outcomes">'+chips.join('')+'</div>' : '';
  }
  function breedingTimeline(rows){
    return '<div class="b-timeline-list">'+rows.map(function(l){
      var doe = rabbitById(l.doeId);
      var buck = rabbitById(l.buckId);
      var kits = kitsForLitter(l);
      var st = litterStatus(l);
      var matingDate = l.matingDate || null;
      var palpationTarget = matingDate ? addDays(matingDate, PALPATION_DAYS) : null;
      var dueDate = l.dueDate || (matingDate ? addDays(matingDate, GEST_DAYS) : null);
      var weanTarget = l.kindleDate ? addDays(l.kindleDate, WEAN_TARGET_DAYS) : null;

      var palpationOverdue = !l.palpationDate && palpationTarget && daysFromToday(palpationTarget) < 0;
      var kindlingOverdue = !l.kindleDate && dueDate && daysFromToday(dueDate) < 0;
      var weaningOverdue = !l.weanDate && weanTarget && daysFromToday(weanTarget) < 0;
      var attention = palpationOverdue || kindlingOverdue || weaningOverdue;

      function stage(label, shownDate, done, overdue){
        var cls = 'b-stage'+(done?' done':'')+(overdue?' overdue':'')+(!done&&!overdue?' pending':'');
        var stateLabel = done ? 'Done' : (overdue ? 'Overdue' : 'Pending');
        return '<div class="'+cls+'"><div class="b-stage-label">'+label+'</div><div class="b-stage-date mono">'+(shownDate?fmtDate(shownDate):'—')+'</div><div class="b-stage-state">'+stateLabel+'</div></div>';
      }

      return '<div class="b-card'+(attention?' b-card-attn':'')+'">'+
        '<div class="b-card-head"><div class="b-pair">'+rabbitListLink(doe, true)+' <span class="b-x">×</span> '+rabbitListLink(buck, true)+'</div>'+
        '<div class="b-card-actions"><span class="w-pill '+st.cls+'">'+st.label+'</span>'+(attention?'<span class="b-attn">Needs attention</span>':'')+
        (can('worker')?'<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('open-litter-modal', {id:l.id})+'>Update</button>':'')+'</div></div>'+
        '<div class="b-kits">'+(l.kitsBorn!=null? l.kitsBorn+' born, '+(l.kitsAlive!=null?l.kitsAlive:l.kitsBorn)+' alive' : 'No kit counts yet')+'</div>'+
        breedingOutcomeSummary(l)+
        (kits.length? '<div class="b-notes"><b>Kits:</b> '+kits.map(function(k){
          return rabbitListLink(k, true)+' <button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('open-health-modal', {rabbitId:k.id, prefillType:'Weight log'})+'>Growth</button> <button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('open-health-modal', {rabbitId:k.id})+'>Health</button> <button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('open-ledger-modal', {rabbitId:k.id, prefillType:'Sale', prefillCategory:'Rabbit sale'})+'>Sale</button>';
        }).join(' ')+'</div>' : '')+
        '<div class="b-details">'+
          breedingDetailLine('Mating notes', l.matingNotes)+
          breedingDetailLine('Kindling notes', l.kindlingNotes)+
          breedingDetailLineCount('Fostered in', l.fosterInCount)+
          breedingDetailLineCount('Fostered out', l.fosterOutCount)+
          breedingDetailLine('Mortality reasons', l.mortalityReasons)+
          breedingDetailLine('Weaning outcome', l.weaningOutcome)+
        '</div>'+
        '<div class="b-timeline-grid">'+
          stage('Planned mating', l.createdAt || matingDate, true, false)+
          stage('Mated', matingDate, !!matingDate, false)+
          stage('Palpation check', l.palpationDate || palpationTarget, !!l.palpationDate, palpationOverdue)+
          stage('Due', dueDate, !!l.kindleDate, kindlingOverdue)+
          stage('Kindled', l.kindleDate, !!l.kindleDate, kindlingOverdue)+
          stage('Weaned', l.weanDate || weanTarget, !!l.weanDate, weaningOverdue)+
          stage('Closed', l.weanDate, !!l.weanDate, false)+
        '</div>'+
        (l.notes?'<div class="b-notes"><b>Notes:</b> '+esc(l.notes)+'</div>':'')+
      '</div>';
    }).join('')+'</div>';
  }
  function openLitterModal(id){
    var l = id ? state.litters.find(function(x){return x.id===id;}) : null;
    var linkedKits = kitsForLitter(l);
    var suggestedKitCount = (l&&l.kitsAlive!=null)?l.kitsAlive:((l&&l.kitsBorn!=null)?l.kitsBorn:0);
    var html = '<div class="w-modal"><h3>'+(l?'Update pairing':'Record pairing')+'</h3><form id="w-litter-form">'+
      '<div class="w-row2"><div class="w-field"><label>Doe</label><select name="doeId" required>'+rabbitOptions(l?l.doeId:'', null,'doe')+'</select></div>'+
      '<div class="w-field"><label>Buck</label><select name="buckId" required>'+rabbitOptions(l?l.buckId:'', null,'buck')+'</select></div></div>'+
      '<div class="w-field"><label>Mating date</label><input type="date" name="matingDate" required value="'+esc(l?l.matingDate:todayStr())+'"/></div>'+
      '<div class="w-row2"><div class="w-field"><label>Palpation check</label><input type="date" name="palpationDate" value="'+esc(l?l.palpationDate:'')+'"/></div>'+
      '<div class="w-field"><label>Kindle date (if born)</label><input type="date" name="kindleDate" value="'+esc(l?l.kindleDate:'')+'"/></div>'+
      '<div class="w-field"><label>Wean date (if weaned)</label><input type="date" name="weanDate" value="'+esc(l?l.weanDate:'')+'"/></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Kits born</label><input type="number" name="kitsBorn" value="'+(l&&l.kitsBorn!=null?l.kitsBorn:'')+'"/></div>'+
      '<div class="w-field"><label>Kits alive</label><input type="number" name="kitsAlive" value="'+(l&&l.kitsAlive!=null?l.kitsAlive:'')+'"/></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Fostered in</label><input type="number" min="0" name="fosterInCount" value="'+(l&&l.fosterInCount!=null?l.fosterInCount:'')+'"/></div>'+
      '<div class="w-field"><label>Fostered out</label><input type="number" min="0" name="fosterOutCount" value="'+(l&&l.fosterOutCount!=null?l.fosterOutCount:'')+'"/></div></div>'+
      '<div class="w-field"><label>Mating notes</label><textarea name="matingNotes">'+esc(l?l.matingNotes:'')+'</textarea></div>'+
      '<div class="w-field"><label>Kindling notes</label><textarea name="kindlingNotes">'+esc(l?l.kindlingNotes:'')+'</textarea></div>'+
      '<div class="w-field"><label>Mortality reasons</label><textarea name="mortalityReasons" placeholder="Stillborn, chilling, cannibalism, illness, etc.">'+esc(l?l.mortalityReasons:'')+'</textarea></div>'+
      '<div class="w-field"><label>Weaning outcome</label><textarea name="weaningOutcome" placeholder="How the litter performed at weaning">'+esc(l?l.weaningOutcome:'')+'</textarea></div>'+
      '<div class="w-panel" style="padding:10px 12px;margin-bottom:10px;">'+
        '<div style="font-size:.8rem;font-weight:700;color:var(--ink);margin-bottom:6px;">Kit-level tracking</div>'+
        '<label style="display:flex;align-items:center;gap:8px;font-size:.83rem;color:var(--ink);"><input type="checkbox" name="generateKits" '+((!l || !linkedKits.length)?'checked':'')+'/> Generate kit records when kindling is saved</label>'+
        '<div class="w-row2" style="margin-top:8px;"><div class="w-field"><label>How many kit records?</label><input type="number" min="1" name="kitCreateCount" value="'+(suggestedKitCount||1)+'"/></div><div class="w-field"><label>Already linked kits</label><div class="w-static">'+linkedKits.length+'</div></div></div>'+
        (linkedKits.length? '<div class="w-sub">'+linkedKits.map(function(k){ return rabbitListLink(k, true); }).join(' ')+'</div>' : '<div class="w-sub">No kit records linked yet.</div>')+
      '</div>'+
      '<div class="w-field"><label>Notes</label><textarea name="notes">'+esc(l?l.notes:'')+'</textarea></div>'+
      '<div class="w-modalfoot">'+(l&&can('supervisor')?'<button type="button" class="w-btn w-btn-danger"'+clickAttrs('delete-litter', {id:l.id})+'>Delete</button>':'<span></span>')+
      '<span style="flex:1"></span><button type="button" class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Cancel</button>'+
      '<button type="submit" class="w-btn w-btn-primary">Save</button></div></form></div>';
    showModal(html);
    document.getElementById('w-litter-form').onsubmit = async function(e){
      e.preventDefault(); var f = new FormData(e.target); var matingDate = f.get('matingDate');
      var body = {doeId:f.get('doeId'), buckId:f.get('buckId'), matingDate:matingDate, dueDate:addDays(matingDate, GEST_DAYS),
        palpationDate:f.get('palpationDate')||null,
        kindleDate:f.get('kindleDate')||null, weanDate:f.get('weanDate')||null,
        kitsBorn:f.get('kitsBorn')?parseInt(f.get('kitsBorn')):null, kitsAlive:f.get('kitsAlive')?parseInt(f.get('kitsAlive')):null,
        fosterInCount:f.get('fosterInCount')?parseInt(f.get('fosterInCount'), 10):0,
        fosterOutCount:f.get('fosterOutCount')?parseInt(f.get('fosterOutCount'), 10):0,
        matingNotes:f.get('matingNotes')||'',
        kindlingNotes:f.get('kindlingNotes')||'',
        mortalityReasons:f.get('mortalityReasons')||'',
        weaningOutcome:f.get('weaningOutcome')||'',
        notes:f.get('notes')};
      var wantsGenerate = f.get('generateKits') === 'on';
      var requestedKitCount = f.get('kitCreateCount') ? parseInt(f.get('kitCreateCount'), 10) : 0;
      try{
        var litterRow = l ? await updateItem('litters', l.id, body) : await createItem('litters', body);
        var createdCount = 0;
        if(wantsGenerate && litterRow.kindleDate){
          var currentKits = kitsForLitter(litterRow);
          var desired = requestedKitCount || (litterRow.kitsAlive!=null ? litterRow.kitsAlive : (litterRow.kitsBorn!=null ? litterRow.kitsBorn : 0));
          desired = Math.max(desired, currentKits.length);
          var toCreate = Math.max(0, desired - currentKits.length);
          if(toCreate > 0){
            var created = await createKitRecordsForLitter(litterRow, toCreate);
            createdCount = created.length;
            var mergedKitIds = currentKits.map(function(r){ return r.id; }).concat(created.map(function(r){ return r.id; }));
            litterRow = await updateItem('litters', litterRow.id, {kitIds:mergedKitIds});
          }
        }
        closeModal();
        renderMain();
        showToast('Breeding record saved'+(createdCount?(' and '+createdCount+' kit record(s) generated'):'')+'.');
      }
      catch(err){ showToast(friendlyError(err), true); }
    };
  }
  async function deleteLitter(id){
    if(!confirm('Delete this breeding record?')) return;
    try{ await deleteItemApi('litters', id); closeModal(); renderMain(); showToast('Record deleted'); }
    catch(err){ showToast(friendlyError(err), true); }
  }

  // ============ HEALTH ============
  function viewHealth(){
    var rows = state.health.slice().sort(function(a,b){return new Date(b.date)-new Date(a.date);});
    return '<div class="w-headrow"><div><h2>Health</h2><div class="w-sub">'+state.health.length+' records</div></div>'+
      (can('worker')?'<button class="w-btn w-btn-primary"'+clickAttrs('open-health-modal')+'>+ Log record</button>':'')+'</div>'+
      '<div class="w-panel">'+(rows.length? healthTable(rows):'<div class="w-empty"><p>No health records yet.</p></div>')+'</div>';
  }
  function healthTable(rows){
    return '<table class="w-table"><thead><tr><th>Date</th><th>Rabbit</th><th>Type</th><th>Notes</th><th>Next due</th></tr></thead><tbody>'+
      rows.map(function(h){
        var r = rabbitById(h.rabbitId);
        return '<tr><td class="mono" style="font-size:.78rem;">'+fmtDate(h.date)+'</td><td>'+rabbitListLink(r, true)+'</td>'+
          '<td>'+esc(h.type)+(h.weight?' ('+h.weight+' lb)':'')+'</td><td style="color:var(--ink-muted);">'+esc(h.description||'—')+'</td>'+
          '<td class="mono" style="font-size:.78rem;">'+(h.nextDue?fmtDate(h.nextDue):'—')+'</td></tr>';
      }).join('')+'</tbody></table>';
  }
  function openHealthModal(prefillRabbitId, prefillType){
    var html = '<div class="w-modal"><h3>Log health record</h3><form id="w-health-form">'+
      '<div class="w-field"><label>Rabbit</label><select name="rabbitId" required>'+rabbitOptions(prefillRabbitId||'',null,null)+'</select></div>'+
      '<div class="w-row2"><div class="w-field"><label>Date</label><input type="date" name="date" required value="'+todayStr()+'"/></div>'+
      '<div class="w-field"><label>Type</label><select name="type"><option '+(prefillType==='Vaccination'?'selected':'')+'>Vaccination</option><option '+(prefillType==='Treatment'?'selected':'')+'>Treatment</option><option '+(prefillType==='Checkup'?'selected':'')+'>Checkup</option><option '+(prefillType==='Weight log'?'selected':'')+'>Weight log</option></select></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Weight (lb, optional)</label><input type="number" step="0.1" name="weight"/></div>'+
      '<div class="w-field"><label>Next due (optional)</label><input type="date" name="nextDue"/></div></div>'+
      '<div class="w-field"><label>Notes</label><textarea name="description"></textarea></div>'+
      '<div class="w-modalfoot"><span style="flex:1"></span><button type="button" class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Cancel</button>'+
      '<button type="submit" class="w-btn w-btn-primary">Save record</button></div></form></div>';
    showModal(html);
    document.getElementById('w-health-form').onsubmit = async function(e){
      e.preventDefault(); var f = new FormData(e.target);
      var body = {rabbitId:f.get('rabbitId'), date:f.get('date'), type:f.get('type'), weight:f.get('weight')?parseFloat(f.get('weight')):null, nextDue:f.get('nextDue')||null, description:f.get('description')};
      try{ await createItem('health', body); closeModal(); renderMain(); showToast('Health record saved'); }
      catch(err){ showToast(friendlyError(err), true); }
    };
  }

  // ============ HOUSING ============
  function viewHousing(){
    var active = state.rabbits.filter(function(r){return r.status==='active';});
    var groups = state.cages.reduce(function(acc, c){
      var key = String(c.location || '').trim() || 'Unassigned location';
      if(!acc[key]) acc[key] = [];
      acc[key].push(c);
      return acc;
    }, {});
    var locations = Object.keys(groups).sort(function(a,b){ return a.localeCompare(b); });
    return '<div class="w-headrow"><div><h2>Housing</h2><div class="w-sub">'+state.cages.length+' hutches</div></div>'+
      (can('worker')?'<button class="w-btn w-btn-primary"'+clickAttrs('open-cage-modal')+'>+ Add hutch</button>':'')+'</div>'+
      housingLegend()+
      (state.cages.length? '<div>'+locations.map(function(location){
        return '<div class="w-panel h-location-group" style="padding:16px 18px;margin-bottom:14px;"><h3 style="margin-bottom:10px;">'+esc(location)+'</h3><div class="w-stats">'+
        groups[location].sort(function(a,b){ return String(a.label||'').localeCompare(String(b.label||'')); }).map(function(c){
        var occ = active.filter(function(r){return r.cageId===c.id;});
        var occMeta = occupancyMeta(occ.length, c.capacity);
        return '<div class="w-panel h-hutch-card '+hutchTypeClass(c.allowedSex)+' '+occMeta.cls+'" style="margin-bottom:0;"><div style="display:flex;justify-content:space-between;align-items:flex-start;"><h3 style="border:none;padding:0;font-size:.95rem;">'+esc(c.label)+'</h3>'+
          (can('worker')?'<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('open-cage-modal', {id:c.id})+'>Edit</button>':'')+'</div>'+
          '<div class="h-chip-row" style="margin-bottom:8px;"><span class="h-chip h-type-chip '+hutchTypeClass(c.allowedSex)+'">'+esc(hutchTypeLabel(c.allowedSex))+'</span><span class="h-chip h-occ-chip '+occMeta.cls+'">'+esc(occMeta.label)+'</span></div>'+
          '<div class="mono h-occ-count" style="font-size:1.1rem;font-weight:700;">'+occ.length+' / '+c.capacity+'</div>'+
          '<div style="font-size:.72rem;color:var(--ink-muted);margin-bottom:6px;">occupants</div>'+
          (occ.length? occ.map(function(r){return rabbitListLink(r, false);}).join(' ') : '<span style="font-size:.78rem;color:var(--ink-muted);">Empty</span>')+
          '<div class="h-maint" style="margin-top:10px;font-size:.78rem;color:var(--ink-muted);"><b>Maintenance notes:</b> '+esc(c.maintenanceNotes||'—')+'</div>'+
          '</div>';
      }).join('')+'</div></div>';
      }).join('')+'</div>' : '<div class="w-panel w-empty"><p>No hutches set up yet.</p></div>');
  }
  function openCageModal(id){
    var c = id ? cageById(id) : null;
    var html = '<div class="w-modal"><h3>'+(c?'Edit hutch':'Add hutch')+'</h3><form id="w-cage-form">'+
      '<div class="w-field"><label>Label</label><input name="label" required value="'+esc(c?c.label:'')+'" placeholder="e.g. Row A-3"/></div>'+
      '<div class="w-row2"><div class="w-field"><label>Location</label><input name="location" value="'+esc(c?c.location:'')+'" placeholder="e.g. North barn"/></div>'+
      '<div class="w-field"><label>Capacity</label><input type="number" name="capacity" min="1" value="'+(c?c.capacity:1)+'"/></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Hutch type</label><select name="allowedSex"><option value="any" '+(!c||!c.allowedSex||c.allowedSex==='any'?'selected':'')+'>Any</option><option value="doe" '+(c&&c.allowedSex==='doe'?'selected':'')+'>Doe</option><option value="buck" '+(c&&c.allowedSex==='buck'?'selected':'')+'>Buck</option><option value="kits" '+(c&&c.allowedSex==='kits'?'selected':'')+'>Kits</option></select></div><div class="w-field"></div></div>'+
      '<div class="w-field"><label>Maintenance notes</label><textarea name="maintenanceNotes" placeholder="Repairs, cleaning, disinfection, upgrades, and dates">'+esc(c?c.maintenanceNotes:'')+'</textarea></div>'+
      '<div class="w-modalfoot">'+(c&&can('supervisor')?'<button type="button" class="w-btn w-btn-danger"'+clickAttrs('delete-cage', {id:c.id})+'>Delete</button>':'<span></span>')+
      '<span style="flex:1"></span><button type="button" class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Cancel</button>'+
      '<button type="submit" class="w-btn w-btn-primary">Save</button></div></form></div>';
    showModal(html);
    document.getElementById('w-cage-form').onsubmit = async function(e){
      e.preventDefault(); var f = new FormData(e.target);
      var body = {
        label:f.get('label'),
        location:f.get('location'),
        capacity:parseInt(f.get('capacity'))||1,
        allowedSex:f.get('allowedSex')||'any',
        maintenanceNotes:f.get('maintenanceNotes')||''
      };
      try{ if(c) await updateItem('cages', c.id, body); else await createItem('cages', body); closeModal(); renderMain(); showToast('Hutch saved'); }
      catch(err){ showToast(friendlyError(err), true); }
    };
  }
  async function deleteCage(id){
    if(!confirm('Delete this hutch? Rabbits assigned to it will need reassigning.')) return;
    try{ await deleteItemApi('cages', id); closeModal(); renderMain(); showToast('Hutch deleted'); }
    catch(err){ showToast(friendlyError(err), true); }
  }

  // ============ FEED ============
  function viewFeed(){
    var rows = state.feedStock.slice().sort(function(a,b){return a.name.localeCompare(b.name);});
    var low = rows.filter(isLowStock).length;
    return '<div class="w-headrow"><div><h2>Feed</h2><div class="w-sub">'+rows.length+' stock items</div></div>'+
      (can('worker')?'<button class="w-btn w-btn-primary"'+clickAttrs('open-feed-item-modal')+'>+ Add feed item</button>':'')+'</div>'+
      '<div class="w-stats">'+stat(rows.length,'Stock items')+stat(low,'Low stock')+'</div>'+
      '<div class="w-panel">'+(rows.length? feedTable(rows) : '<div class="w-empty"><p>No feed stock tracked yet.</p></div>')+'</div>';
  }
  function feedTable(rows){
    return '<table class="w-table"><thead><tr><th>Item</th><th>On hand</th><th>Reorder at</th><th>Status</th><th></th></tr></thead><tbody>'+
      rows.map(function(f){
        var low = isLowStock(f);
        return '<tr><td>'+esc(f.name)+(f.notes?'<div style="font-size:.72rem;color:var(--ink-muted);">'+esc(f.notes)+'</div>':'')+'</td>'+
          '<td class="mono">'+f.quantity+' '+esc(f.unit)+'</td><td class="mono" style="color:var(--ink-muted);">'+f.reorderLevel+' '+esc(f.unit)+'</td>'+
          '<td><span class="w-pill '+(low?'pill-warn':'pill-moss')+'">'+(low?'Low':'OK')+'</span></td>'+
          '<td style="white-space:nowrap;">'+(can('worker')?('<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('open-feed-adjust-modal', {id:f.id, kind:'restock'})+'>Restock</button> <button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('open-feed-adjust-modal', {id:f.id, kind:'use'})+'>Use</button> <button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('open-feed-item-modal', {id:f.id})+'>Edit</button>'):'')+'</td></tr>';
      }).join('')+'</tbody></table>';
  }
  function openFeedItemModal(id){
    var f = id ? feedItemById(id) : null;
    var html = '<div class="w-modal"><h3>'+(f?'Edit feed item':'Add feed item')+'</h3><form id="w-feed-form">'+
      '<div class="w-field"><label>Item name</label><input name="name" required value="'+esc(f?f.name:'')+'" placeholder="e.g. Alfalfa pellets"/></div>'+
      '<div class="w-row2"><div class="w-field"><label>Quantity on hand</label><input type="number" step="0.1" name="quantity" required value="'+(f?f.quantity:'')+'"/></div>'+
      '<div class="w-field"><label>Unit</label><select name="unit"><option '+(f&&f.unit==='lb'?'selected':'')+'>lb</option><option '+(f&&f.unit==='kg'?'selected':'')+'>kg</option><option '+(f&&f.unit==='bag'?'selected':'')+'>bag</option><option '+(f&&f.unit==='bale'?'selected':'')+'>bale</option></select></div></div>'+
      '<div class="w-field"><label>Reorder level</label><input type="number" step="0.1" name="reorderLevel" required value="'+(f?f.reorderLevel:'')+'"/></div>'+
      '<div class="w-field"><label>Notes</label><textarea name="notes">'+esc(f?f.notes:'')+'</textarea></div>'+
      '<div class="w-modalfoot">'+(f&&can('supervisor')?'<button type="button" class="w-btn w-btn-danger"'+clickAttrs('delete-feed-item', {id:f.id})+'>Delete</button>':'<span></span>')+
      '<span style="flex:1"></span><button type="button" class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Cancel</button>'+
      '<button type="submit" class="w-btn w-btn-primary">Save item</button></div></form></div>';
    showModal(html);
    document.getElementById('w-feed-form').onsubmit = async function(e){
      e.preventDefault(); var d = new FormData(e.target);
      var body = {name:d.get('name'), quantity:parseFloat(d.get('quantity'))||0, unit:d.get('unit'), reorderLevel:parseFloat(d.get('reorderLevel'))||0, notes:d.get('notes')};
      try{ await saveFeedItemApi(f ? f.id : null, body); closeModal(); renderMain(); showToast('Feed item saved'); }
      catch(err){ showToast(friendlyError(err), true); }
    };
  }
  async function deleteFeedItem(id){
    if(!confirm('Remove this feed item from stock tracking?')) return;
    try{ await deleteFeedItemApi(id); closeModal(); renderMain(); showToast('Feed item removed'); }
    catch(err){ showToast(friendlyError(err), true); }
  }
  function openFeedAdjustModal(id, kind){
    var f = feedItemById(id); if(!f) return;
    var isRestock = kind==='restock';
    var html = '<div class="w-modal"><h3>'+(isRestock?'Restock':'Log use of')+' '+esc(f.name)+'</h3>'+
      '<div class="w-sub" style="margin-bottom:12px;">Currently '+f.quantity+' '+esc(f.unit)+' on hand</div>'+
      '<form id="w-feedadjust-form">'+
      '<div class="w-row2"><div class="w-field"><label>Date</label><input type="date" name="date" required value="'+todayStr()+'"/></div>'+
      '<div class="w-field"><label>Amount ('+esc(f.unit)+')</label><input type="number" step="0.1" min="0.1" name="amount" required/></div></div>'+
      (isRestock? '<div class="w-field"><label>Cost ('+esc(currentFarm.currency)+', optional — logs to Ledger)</label><input type="number" step="0.01" name="cost"/></div>' : '')+
      '<div class="w-field"><label>Notes</label><textarea name="notes"></textarea></div>'+
      '<div class="w-modalfoot"><span style="flex:1"></span><button type="button" class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Cancel</button>'+
      '<button type="submit" class="w-btn w-btn-primary">'+(isRestock?'Add stock':'Log use')+'</button></div></form></div>';
    showModal(html);
    document.getElementById('w-feedadjust-form').onsubmit = async function(e){
      e.preventDefault(); var d = new FormData(e.target);
      var amount = parseFloat(d.get('amount'))||0;
      var dateStr = d.get('date'), notes = d.get('notes');
      var cost = isRestock ? (parseFloat(d.get('cost'))||0) : 0;
      try{
        await adjustFeedStockApi(f.id, {kind:kind, date:dateStr, amount:amount, notes:notes, cost:cost});
        closeModal(); renderMain(); showToast('Stock updated');
      }catch(err){ showToast(friendlyError(err), true); }
    };
  }

  // ============ LEDGER ============
  var LEDGER_CATEGORY_PRESETS = {
    Sale: ['Rabbit sale', 'Breeding service', 'Manure sale', 'Equipment resale', 'Other income'],
    Expense: ['Vet visit', 'Medicine', 'Housing repair', 'Utilities', 'Transport', 'Other expense'],
    Feed: ['Pellet feed', 'Hay', 'Supplements', 'Treats', 'Feed additive'],
    Other: ['Adjustment', 'Bank charge', 'Miscellaneous']
  };
  var ledgerFilter = {range:'all', type:'all', rabbit:'all', from:'', to:''};
  function setLedgerFilter(key, value){ ledgerFilter[key]=value||''; if(current==='ledger') renderMain(); }
  function ledgerRangeStart(range){
    var now = new Date(todayStr()+'T00:00:00');
    if(range==='30') now.setDate(now.getDate()-30);
    else if(range==='90') now.setDate(now.getDate()-90);
    else if(range==='month'){ now = new Date(now.getFullYear(), now.getMonth(), 1); }
    else return null;
    return now;
  }
  function ledgerFilterRows(rows){
    var range = ledgerFilter.range || 'all';
    var type = ledgerFilter.type || 'all';
    var rabbit = ledgerFilter.rabbit || 'all';
    var start = null;
    var end = null;
    if(range==='custom'){
      start = ledgerFilter.from ? new Date(ledgerFilter.from+'T00:00:00') : null;
      end = ledgerFilter.to ? new Date(ledgerFilter.to+'T23:59:59') : null;
    }else{
      start = ledgerRangeStart(range);
    }
    return rows.filter(function(e){
      if(type!=='all' && String(e.type||'')!==type) return false;
      if(rabbit==='unassigned' && !!e.rabbitId) return false;
      if(rabbit!=='all' && rabbit!=='unassigned' && String(e.rabbitId||'')!==String(rabbit)) return false;
      if(start || end){
        if(!e.date) return false;
        var d = new Date(String(e.date)+'T12:00:00');
        if(start && d < start) return false;
        if(end && d > end) return false;
      }
      return true;
    });
  }
  function ledgerRowsWithBalance(rows){
    var asc = rows.slice().sort(function(a,b){
      var da = String(a.date||'');
      var db = String(b.date||'');
      if(da!==db) return da.localeCompare(db);
      return String(a.id||'').localeCompare(String(b.id||''));
    });
    var running = 0;
    var byId = {};
    asc.forEach(function(e){
      var amount = Number(e.amount)||0;
      running += (String(e.type)==='Sale') ? amount : -amount;
      byId[e.id] = running;
    });
    return rows.map(function(e){ return Object.assign({}, e, {runningBalance: byId[e.id]||0}); });
  }
  function ledgerFilterControls(){
    var rabbitOptionsHtml = ['<option value="all">All rabbits</option>','<option value="unassigned" '+(ledgerFilter.rabbit==='unassigned'?'selected':'')+'>Unassigned</option>'];
    state.rabbits.slice().sort(function(a,b){ return String(a.tag||'').localeCompare(String(b.tag||'')); }).forEach(function(r){
      rabbitOptionsHtml.push('<option value="'+esc(r.id)+'" '+(ledgerFilter.rabbit===r.id?'selected':'')+'>'+esc(r.tag)+' — '+esc(r.name)+'</option>');
    });
    return '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:flex-end;">'+
      '<select'+changeAttrs('set-ledger-filter', {key:'range'})+' style="padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--bg);">'+
        '<option value="all" '+(ledgerFilter.range==='all'?'selected':'')+'>All dates</option>'+
        '<option value="month" '+(ledgerFilter.range==='month'?'selected':'')+'>This month</option>'+
        '<option value="30" '+(ledgerFilter.range==='30'?'selected':'')+'>Last 30 days</option>'+
        '<option value="90" '+(ledgerFilter.range==='90'?'selected':'')+'>Last 90 days</option>'+
        '<option value="custom" '+(ledgerFilter.range==='custom'?'selected':'')+'>Custom range</option>'+
      '</select>'+
      '<select'+changeAttrs('set-ledger-filter', {key:'type'})+' style="padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--bg);">'+
        '<option value="all" '+(ledgerFilter.type==='all'?'selected':'')+'>All types</option>'+
        '<option value="Sale" '+(ledgerFilter.type==='Sale'?'selected':'')+'>Sale</option>'+
        '<option value="Expense" '+(ledgerFilter.type==='Expense'?'selected':'')+'>Expense</option>'+
        '<option value="Feed" '+(ledgerFilter.type==='Feed'?'selected':'')+'>Feed</option>'+
        '<option value="Other" '+(ledgerFilter.type==='Other'?'selected':'')+'>Other</option>'+
      '</select>'+
      '<select'+changeAttrs('set-ledger-filter', {key:'rabbit'})+' style="padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--bg);">'+rabbitOptionsHtml.join('')+'</select>'+
      (ledgerFilter.range==='custom' ? '<input type="date" value="'+esc(ledgerFilter.from||'')+'"'+changeAttrs('set-ledger-filter', {key:'from'})+' style="padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--bg);"/><input type="date" value="'+esc(ledgerFilter.to||'')+'"'+changeAttrs('set-ledger-filter', {key:'to'})+' style="padding:7px 10px;border:1px solid var(--line);border-radius:4px;background:var(--bg);"/>' : '')+
      '<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('export-ledger-csv')+'>Export CSV</button>'+
    '</div>';
  }
  function exportLedgerCsv(){
    var allRows = state.ledger.slice().sort(function(a,b){return new Date(b.date)-new Date(a.date);});
    var filtered = ledgerFilterRows(allRows);
    var rows = ledgerRowsWithBalance(filtered);
    if(!rows.length){ showToast('No ledger entries in current filter.', true); return; }
    var income = filtered.filter(function(e){return e.type==='Sale';}).reduce(function(s,e){return s+Number(e.amount||0);},0);
    var expense = filtered.filter(function(e){return e.type!=='Sale';}).reduce(function(s,e){return s+Number(e.amount||0);},0);
    var table = [
      ['Date','Type','Category','Rabbit','Amount','Running balance','Notes']
    ];
    rows.forEach(function(e){
      var r = e.rabbitId ? rabbitById(e.rabbitId) : null;
      table.push([
        e.date || '',
        e.type || '',
        e.category || '',
        r ? (r.tag+' — '+r.name) : '',
        Number(e.amount||0).toFixed(2),
        Number(e.runningBalance||0).toFixed(2),
        e.notes || ''
      ]);
    });
    table.push([]);
    table.push(['Income', Number(income).toFixed(2)]);
    table.push(['Expenses', Number(expense).toFixed(2)]);
    table.push(['Net', Number(income-expense).toFixed(2)]);
    downloadCsv('ledger-'+todayStr()+'.csv', table);
    showToast('Ledger CSV downloaded.');
  }
  function viewLedger(){
    var allRows = state.ledger.slice().sort(function(a,b){return new Date(b.date)-new Date(a.date);});
    var filtered = ledgerFilterRows(allRows);
    var rows = ledgerRowsWithBalance(filtered);
    var income = filtered.filter(function(e){return e.type==='Sale';}).reduce(function(s,e){return s+Number(e.amount||0);},0);
    var expense = filtered.filter(function(e){return e.type!=='Sale';}).reduce(function(s,e){return s+Number(e.amount||0);},0);
    return '<div class="w-headrow"><div><h2>Ledger</h2><div class="w-sub">Sales, feed &amp; expenses in '+esc(currentFarm.currency)+'</div></div>'+
      (can('worker')?'<button class="w-btn w-btn-primary"'+clickAttrs('open-ledger-modal')+'>+ Add entry</button>':'')+'</div>'+
      '<div class="w-stats">'+stat(money(income),'Income')+stat(money(expense),'Expenses')+stat(money(income-expense),'Net')+'</div>'+
      '<div class="w-panel">'+ledgerFilterControls()+'</div>'+
      '<div class="w-panel">'+(rows.length? ledgerTable(rows) : '<div class="w-empty"><p>No ledger entries yet.</p></div>')+'</div>';
  }
  function ledgerTable(rows){
    return '<table class="w-table"><thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Rabbit</th><th>Amount</th><th>Running balance</th><th>Notes</th></tr></thead><tbody>'+
      rows.map(function(e){
        var r = e.rabbitId?rabbitById(e.rabbitId):null;
        return '<tr><td class="mono" style="font-size:.78rem;">'+fmtDate(e.date)+'</td><td><span class="w-pill '+(e.type==='Sale'?'pill-moss':'pill-clay')+'">'+esc(e.type)+'</span></td>'+
          '<td>'+esc(e.category)+'</td><td>'+rabbitListLink(r, false)+'</td><td class="mono">'+money(e.amount)+'</td><td class="mono">'+money(e.runningBalance||0)+'</td><td style="color:var(--ink-muted);">'+esc(e.notes||'')+'</td></tr>';
      }).join('')+'</tbody></table>';
  }
  function openLedgerModal(prefillRabbitId, prefillType, prefillCategory){
    function presetsForType(type){ return LEDGER_CATEGORY_PRESETS[type] || LEDGER_CATEGORY_PRESETS.Other; }
    var html = '<div class="w-modal"><h3>Add ledger entry</h3><form id="w-ledger-form">'+
      '<div class="w-row2"><div class="w-field"><label>Date</label><input type="date" name="date" required value="'+todayStr()+'"/></div>'+
      '<div class="w-field"><label>Type</label><select name="type"><option '+(prefillType==='Sale'?'selected':'')+'>Sale</option><option '+(prefillType==='Expense'?'selected':'')+'>Expense</option><option '+(prefillType==='Feed'?'selected':'')+'>Feed</option><option '+(prefillType==='Other'?'selected':'')+'>Other</option></select></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Category</label><input name="category" placeholder="e.g. Pellet feed, Vet visit, Rabbit sale" required/></div>'+
      '<div class="w-field"><label>Amount ('+esc(currentFarm.currency)+')</label><input type="number" step="0.01" name="amount" required/></div></div>'+
      '<div id="w-ledger-category-presets" style="display:flex;gap:6px;flex-wrap:wrap;margin:-6px 0 10px 0;"></div>'+
      '<div class="w-field"><label>Related rabbit (optional)</label><select name="rabbitId">'+rabbitOptions(prefillRabbitId||'',null,null)+'</select></div>'+
      '<div class="w-field"><label>Notes</label><textarea name="notes"></textarea></div>'+
      '<div class="w-modalfoot"><span style="flex:1"></span><button type="button" class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Cancel</button>'+
      '<button type="submit" class="w-btn w-btn-primary">Save entry</button></div></form></div>';
    showModal(html);
    var form = document.getElementById('w-ledger-form');
    var typeInput = form.querySelector('select[name="type"]');
    var categoryInput = form.querySelector('input[name="category"]');
    var rabbitInput = form.querySelector('select[name="rabbitId"]');
    var notesInput = form.querySelector('textarea[name="notes"]');
    var presetsWrap = document.getElementById('w-ledger-category-presets');

    function maybeAutofillSaleLinkNote(){
      if(typeInput.value!=='Sale') return;
      if(!rabbitInput.value) return;
      if(String(notesInput.value||'').trim()) return;
      var r = rabbitById(rabbitInput.value);
      if(!r) return;
      notesInput.value = 'Sale linked to '+(r.tag||'')+' — '+(r.name||'')+'.';
    }
    function renderCategoryPresets(){
      var items = presetsForType(typeInput.value);
      presetsWrap.innerHTML = items.map(function(label){
        return '<button type="button" class="w-btn w-btn-ghost w-btn-sm" data-ledger-preset="'+esc(label)+'">'+esc(label)+'</button>';
      }).join('');
    }
    function maybeAutofillCategory(){
      if(String(categoryInput.value||'').trim()) return;
      var first = presetsForType(typeInput.value)[0];
      if(first) categoryInput.value = first;
    }

    renderCategoryPresets();
    if(prefillCategory) categoryInput.value = prefillCategory;
    maybeAutofillCategory();
    maybeAutofillSaleLinkNote();

    typeInput.onchange = function(){
      renderCategoryPresets();
      maybeAutofillCategory();
      maybeAutofillSaleLinkNote();
    };
    rabbitInput.onchange = function(){ maybeAutofillSaleLinkNote(); };
    presetsWrap.onclick = function(ev){
      var btn = ev.target.closest('[data-ledger-preset]');
      if(!btn) return;
      categoryInput.value = btn.dataset.ledgerPreset || '';
      maybeAutofillSaleLinkNote();
    };

    form.onsubmit = async function(e){
      e.preventDefault(); var f = new FormData(e.target);
      var body = {date:f.get('date'), type:f.get('type'), category:f.get('category'), amount:parseFloat(f.get('amount'))||0, rabbitId:f.get('rabbitId')||null, notes:f.get('notes')};
      try{ await createLedgerEntryApi(body); closeModal(); renderMain(); showToast('Ledger entry saved'); }
      catch(err){ showToast(friendlyError(err), true); }
    };
  }

  // ============ TEAM ============
  var teamMembers = [];
  async function loadAndRenderTeam(){
    try{
      var docs = await Promise.all([
        db.collection('farms').doc(currentFarm.id).get(),
        db.collection('farms').doc(currentFarm.id).collection('members').get()
      ]);
      var farmSnap = docs[0];
      var snap = docs[1];
      if(farmSnap.exists){
        var farmData = farmSnap.data() || {};
        currentFarm = Object.assign({}, currentFarm, {
          name: farmData.name || currentFarm.name,
          currency: farmData.currency || currentFarm.currency,
          timezone: farmData.timezone || currentFarm.timezone || 'UTC',
          address: farmData.address || '',
          website: farmData.website || '',
          contactNumbers: farmData.contactNumbers || '',
          contactEmail: farmData.contactEmail || '',
          contactPerson: farmData.contactPerson || '',
          notes: farmData.notes || ''
        });
      }
      teamMembers = snap.docs.map(function(d){ return Object.assign({uid:d.id}, d.data()); });
    }catch(e){ showToast(friendlyError(e), true); teamMembers=[]; }
    var main = document.getElementById('w-main');
    if(main && current==='team') main.innerHTML = viewTeam();
    var settingsForm = document.getElementById('w-farmsettings-form');
    if(settingsForm) settingsForm.onsubmit = handleFarmSettingsSubmit;
    var addMemberForm = document.getElementById('w-addmember-form');
    if(addMemberForm) addMemberForm.onsubmit = handleAddMemberSubmit;
  }
  function viewTeam(){
    var roleOpts = ['viewer','worker','supervisor','farm_manager'];
    var editableRoleOpts = can('farm_manager') ? roleOpts : roleOpts.filter(function(r){ return r !== 'farm_manager'; });
    var canManage = canManageTeam();
    var websiteValue = String(currentFarm.website || '').trim();
    var websiteHref = websiteValue && /^https?:\/\//i.test(websiteValue) ? websiteValue : (websiteValue ? 'https://' + websiteValue : '');
    return '<div class="w-headrow"><div><h2>Team</h2><div class="w-sub">Who has access to '+esc(currentFarm.name)+'</div></div></div>'+
      (memberNotice? '<div class="w-notice-banner"><div><b>'+esc(memberNotice.title||'Notice')+'</b><div>'+esc(memberNotice.detail||memberNotice.message)+'</div></div><button type="button" class="w-notice-close"'+clickAttrs('dismiss-member-notice')+'>×</button></div>' : '')+
      (can('farm_manager')? ('<div class="w-panel"><h3>Farm settings</h3><form id="w-farmsettings-form" class="w-row2">'+
        '<div class="w-field"><label>Farm name</label><input name="name" value="'+esc(currentFarm.name)+'"/></div>'+
        '<div class="w-field"><label>Currency</label><select name="currency">'+CURRENCIES.map(function(c){return '<option value="'+c+'" '+(c===currentFarm.currency?'selected':'')+'>'+c+'</option>';}).join('')+'</select></div>'+
        '<div class="w-field"><label>Timezone</label><input name="timezone" value="'+esc(currentFarm.timezone||'UTC')+'" placeholder="e.g. Africa/Johannesburg"/></div>'+
        '<div class="w-field" style="grid-column:1/-1;"><label>Physical address</label><textarea name="address" placeholder="Street address, city, region">'+esc(currentFarm.address||'')+'</textarea></div>'+
        '<div class="w-field"><label>Website</label><input type="url" name="website" value="'+esc(currentFarm.website||'')+'" placeholder="https://example.com"/></div>'+
        '<div class="w-field"><label>Contact numbers</label><input name="contactNumbers" value="'+esc(currentFarm.contactNumbers||'')+'" placeholder="e.g. +268 7612 3456, +268 7811 7788"/></div>'+
        '<div class="w-field"><label>Contact email</label><input type="email" name="contactEmail" value="'+esc(currentFarm.contactEmail||'')+'" placeholder="farm@example.com"/></div>'+
        '<div class="w-field"><label>Primary contact person</label><input name="contactPerson" value="'+esc(currentFarm.contactPerson||'')+'" placeholder="e.g. Farm manager"/></div>'+
        '<div class="w-field" style="grid-column:1/-1;"><label>Notes</label><textarea name="notes" placeholder="Other useful farm details">'+esc(currentFarm.notes||'')+'</textarea></div>'+
        '<div style="grid-column:1/-1;"><button type="submit" class="w-btn w-btn-primary">Save farm settings</button></div>'+
      '</form></div>') : ('<div class="w-panel"><h3>Farm settings</h3><div class="w-sub" style="margin-bottom:12px;">Only farm managers can edit these details.</div><div class="w-row2">'+
        '<div class="w-field"><label>Farm name</label><div class="w-static">'+esc(currentFarm.name||'—')+'</div></div>'+
        '<div class="w-field"><label>Currency</label><div class="w-static">'+esc(currentFarm.currency||'—')+'</div></div>'+
        '<div class="w-field"><label>Timezone</label><div class="w-static">'+esc(currentFarm.timezone||'UTC')+'</div></div>'+
        '<div class="w-field" style="grid-column:1/-1;"><label>Physical address</label><div class="w-static">'+esc(currentFarm.address||'—')+'</div></div>'+
        '<div class="w-field"><label>Website</label><div class="w-static">'+(websiteHref? '<a href="'+esc(websiteHref)+'" target="_blank" rel="noopener noreferrer">'+esc(websiteValue)+'</a>' : '—')+'</div></div>'+
        '<div class="w-field"><label>Contact numbers</label><div class="w-static">'+esc(currentFarm.contactNumbers||'—')+'</div></div>'+
        '<div class="w-field"><label>Contact email</label><div class="w-static">'+esc(currentFarm.contactEmail||'—')+'</div></div>'+
        '<div class="w-field"><label>Primary contact person</label><div class="w-static">'+esc(currentFarm.contactPerson||'—')+'</div></div>'+
        '<div class="w-field" style="grid-column:1/-1;"><label>Notes</label><div class="w-static">'+esc(currentFarm.notes||'—')+'</div></div>'+
      '</div></div>'))+
      (canManage? ('<div class="w-panel"><h3>Add a team member</h3><div class="w-sub" style="margin-bottom:10px;">If the member does not yet have an account, the app will create one and issue a temporary PIN.</div><form id="w-addmember-form" class="w-row2">'+
        '<div class="w-field"><label>Email</label><input type="email" name="email" required/></div>'+
        '<div class="w-field"><label>Role</label><select name="role">'+editableRoleOpts.map(function(r){return '<option value="'+r+'">'+r.replace('_',' ')+'</option>';}).join('')+'</select></div>'+
        '<div style="grid-column:1/-1;"><button type="submit" class="w-btn w-btn-primary">Add member</button></div>'+
      '</form></div>') : '<div class="w-panel"><div class="w-sub">Only supervisors and farm managers can add or edit team members.</div></div>')+
      '<div class="w-panel"><h3>Members ('+teamMembers.length+')</h3>'+
        (teamMembers.length? ('<div class="w-member-list">'+
          teamMembers.map(function(m){
            var canEdit = canEditTeamMember(m);
            return '<div class="w-member-card">'+
              '<div class="w-member-top">'+
                '<div class="w-member-info">'+
                  '<div class="w-member-name">'+esc(m.name||'—')+'</div>'+
                  '<div class="w-member-meta mono">'+esc(m.email)+'</div>'+
                '</div>'+
                '<div>'+(canEdit? ('<select'+changeAttrs('change-role', {uid:m.uid})+'>'+editableRoleOpts.map(function(r){return '<option value="'+r+'" '+(r===m.role?'selected':'')+'>'+r.replace('_',' ')+'</option>';}).join('')+'</select>') : ('<span class="w-pill pill-moss">'+m.role.replace('_',' ')+'</span>'))+'</div>'+
              '</div>'+
              (canEdit? ('<div class="w-member-actions"><button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('show-member-pin', {uid:m.uid, email:m.email})+'>Show PIN</button><button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('resend-setup-email', {uid:m.uid, email:m.email})+'>Resend setup</button><button class="w-btn w-btn-danger w-btn-sm"'+clickAttrs('remove-member', {uid:m.uid})+'>Remove</button></div>') : '')+
            '</div>';
          }).join('')+'</div>') : '<div class="w-empty"><p>No members loaded.</p></div>')+
      '</div>';
  }
  async function handleFarmSettingsSubmit(e){
    e.preventDefault(); var f = new FormData(e.target);
    var name = f.get('name'), currency = f.get('currency');
    var timezone = f.get('timezone');
    var address = f.get('address'), website = f.get('website');
    var contactNumbers = f.get('contactNumbers'), contactEmail = f.get('contactEmail');
    var contactPerson = f.get('contactPerson'), notes = f.get('notes');
    try{
      var updateFn = fx.httpsCallable('updateFarmSettings');
      var res = await updateFn({
        farmId:currentFarm.id,
        name:name,
        currency:currency,
        timezone:timezone,
        address:address,
        website:website,
        contactNumbers:contactNumbers,
        contactEmail:contactEmail,
        contactPerson:contactPerson,
        notes:notes
      });
      var farm = res.data || {};
      currentFarm.name = farm.name || name;
      currentFarm.currency = farm.currency || currency;
      currentFarm.timezone = farm.timezone || timezone || currentFarm.timezone || 'UTC';
      currentFarm.address = farm.address || '';
      currentFarm.website = farm.website || '';
      currentFarm.contactNumbers = farm.contactNumbers || '';
      currentFarm.contactEmail = farm.contactEmail || '';
      currentFarm.contactPerson = farm.contactPerson || '';
      currentFarm.notes = farm.notes || '';
      var fi = farms.findIndex(function(x){return x.id===currentFarm.id;});
      if(fi>-1){ farms[fi].name=currentFarm.name; farms[fi].currency=currentFarm.currency; }
      renderRoot(); showToast('Farm settings saved');
    }catch(err){ showToast(friendlyError(err), true); }
  }
  async function handleAddMemberSubmit(e){
    e.preventDefault(); var f = new FormData(e.target);
    if(!canManageTeam()){ showToast('Only supervisors and farm managers can add members.', true); return; }
    var email = String(f.get('email')||'').trim();
    var role = String(f.get('role')||'').trim();
    if(!canAssignTeamRole(role)){ showToast('Only farm managers can assign the farm manager role.', true); return; }
    try{
      var addFn = fx.httpsCallable('addFarmMember');
      var res = await addFn({farmId:currentFarm.id, email:email, role:role});
      if (res.data && res.data.newAccount) {
        var emailReasonMap = {
          'sendgrid-api-key-missing':'Setup email is disabled because SENDGRID_API_KEY is not configured.',
          'sendgrid-from-email-missing':'Setup email is disabled because SENDGRID_FROM_EMAIL is not configured.',
          'sendgrid-request-error':'Email provider request failed. Check function logs and network egress.',
          'missing-email-or-pin':'Missing recipient email or temporary PIN.',
          'sendgrid-http-400':'Email provider rejected the request (400). Check sender and recipient formatting.',
          'sendgrid-http-401':'Email provider authentication failed (401). Check SENDGRID_API_KEY.',
          'sendgrid-http-403':'Email provider denied sender/domain (403). Verify sender identity in SendGrid.',
          'sendgrid-http-404':'Email provider endpoint not found (404).',
          'sendgrid-http-429':'Email provider rate limited requests (429). Retry shortly.',
          'sendgrid-http-500':'Email provider internal error (500). Retry shortly.'
        };
        var detail = 'Share the temporary PIN with the new user and ask them to sign in. The PIN should be given to the user profile before they set a new password. Temporary PIN: ' + (res.data.tempPin || '—') + '.';
        if (res.data.emailSent === false) {
          var reason = (res.data && res.data.emailReason) ? String(res.data.emailReason) : '';
          detail += ' Setup email was not delivered.' + (emailReasonMap[reason] ? (' ' + emailReasonMap[reason]) : (reason ? (' Reason: ' + reason + '.') : '')) + ' Use the Show PIN helper to share it directly.';
        }
        memberNotice = {title:'Temporary PIN created', detail:detail};
      } else {
        memberNotice = null;
        showToast('Member added');
      }
      loadAndRenderTeam();
    }catch(err){ showToast(friendlyError(err), true); }
  }
  async function changeRole(uid, role){
    if(!canManageTeam()){ showToast('Only supervisors and farm managers can update roles.', true); return; }
    var member = findTeamMember(uid);
    if(!canEditTeamMember(member)){ showToast('You do not have permission to edit this member.', true); return; }
    if(!canAssignTeamRole(role)){ showToast('Only farm managers can assign the farm manager role.', true); return; }
    try{
      var changeRoleFn = fx.httpsCallable('updateMemberRole');
      await changeRoleFn({farmId:currentFarm.id, uid:uid, role:role});
      showToast('Role updated'); loadAndRenderTeam();
    }catch(err){ showToast(friendlyError(err), true); loadAndRenderTeam(); }
  }
  async function showMemberPin(uid, email){
    if(!uid){ showToast('No member selected.', true); return; }
    if(!canManageTeam()){ showToast('Only supervisors and farm managers can view member setup details.', true); return; }
    var member = findTeamMember(uid);
    if(!canEditTeamMember(member)){ showToast('You do not have permission to view this member PIN.', true); return; }
    try{
      var doc = await db.collection('users').doc(uid).get();
      var pin = doc.exists && doc.data().tempPin ? String(doc.data().tempPin) : null;
      if(pin){
        memberNotice = {title:'Current temporary PIN', detail:'Share this temporary PIN with the member directly. If the setup email does not arrive, use this PIN: ' + pin + '.'};
        loadAndRenderTeam();
        showToast('Temporary PIN ready to share');
      } else {
        showToast('No temporary PIN is currently available for this member.', true);
      }
    }catch(err){ showToast(friendlyError(err), true); }
  }
  async function resendSetupEmail(uid, email){
    if(!uid || !email){ showToast('No member selected.', true); return; }
    if(!canManageTeam()){ showToast('Only supervisors and farm managers can resend setup emails.', true); return; }
    var member = findTeamMember(uid);
    if(!canEditTeamMember(member)){ showToast('You do not have permission to resend setup for this member.', true); return; }
    try{
      var resendFn = fx.httpsCallable('resendSetupEmail');
      var res = await resendFn({farmId: currentFarm.id, uid: uid, email: email});
      var emailReasonMap = {
        'sendgrid-api-key-missing':'SENDGRID_API_KEY is not configured.',
        'sendgrid-from-email-missing':'SENDGRID_FROM_EMAIL is not configured.',
        'sendgrid-request-error':'Email provider request failed.',
        'missing-email-or-pin':'Missing recipient email or temporary PIN.',
        'sendgrid-http-400':'Email provider rejected the request (400).',
        'sendgrid-http-401':'Email provider authentication failed (401).',
        'sendgrid-http-403':'Email provider denied sender/domain (403).',
        'sendgrid-http-404':'Email provider endpoint not found (404).',
        'sendgrid-http-429':'Email provider rate limited requests (429).',
        'sendgrid-http-500':'Email provider internal error (500).'
      };
      var detail = 'A setup email was requested for ' + email + '.';
      if (res.data && res.data.tempPin) detail += ' Temporary PIN: ' + res.data.tempPin + '.';
      if (res.data && res.data.emailSent === false) {
        var reason = (res.data && res.data.emailReason) ? String(res.data.emailReason) : '';
        detail += ' Email was not delivered.' + (emailReasonMap[reason] ? (' ' + emailReasonMap[reason]) : (reason ? (' Reason: ' + reason + '.') : '')) + ' Use the Show PIN helper to share the temporary PIN directly.';
      }
      memberNotice = {title:'Setup email requested', detail:detail};
      loadAndRenderTeam();
      showToast('Setup email requested');
    }catch(err){ showToast(friendlyError(err), true); }
  }
  async function removeMember(uid){
    if(!canManageTeam()){ showToast('Only supervisors and farm managers can remove members.', true); return; }
    var selected = findTeamMember(uid);
    if(!canEditTeamMember(selected)){ showToast('You do not have permission to remove this member.', true); return; }
    var managers = teamMembers.filter(function(m){return m.role==='farm_manager';});
    if(managers.length===1 && managers[0].uid===uid){ showToast('Cannot remove the only farm manager', true); return; }
    if(!confirm('Remove this person from the farm?')) return;
    try{
      var removeFn = fx.httpsCallable('removeFarmMember');
      await removeFn({farmId:currentFarm.id, uid:uid});
      showToast('Member removed'); loadAndRenderTeam();
    }catch(err){ showToast(friendlyError(err), true); }
  }

  // ============ MODAL HELPERS ============
  function showModal(html){ document.getElementById('w-modal-root').innerHTML = '<div class="w-overlay"'+clickAttrs('close-modal-overlay')+'>'+html+'</div>'; }
  function closeModal(){ var el = document.getElementById('w-modal-root'); if(el) el.innerHTML=''; }
  function setHerdFilter(k,v){ herdFilter[k]=v; renderMain(); }

  window.WApp = {
    setAuthMode:setAuthMode, pickFarm:pickFarm, goNewFarm:goNewFarm, backToPick:backToPick, logout:logout, switchFarm:switchFarm,
    openMenu:openMenu, closeMenu:closeMenu, go:go, requestPasswordReset:requestPasswordReset, dismissMemberNotice:dismissMemberNotice, showMemberPin:showMemberPin, resendSetupEmail:resendSetupEmail,
    openRabbitModal:openRabbitModal, deleteRabbit:deleteRabbit, openRabbitDetail:openRabbitDetail,
    openLitterModal:openLitterModal, deleteLitter:deleteLitter, openHealthModal:openHealthModal,
    openCageModal:openCageModal, deleteCage:deleteCage, openFeedItemModal:openFeedItemModal,
    deleteFeedItem:deleteFeedItem, openFeedAdjustModal:openFeedAdjustModal, openLedgerModal:openLedgerModal,
    closeModal:closeModal, setHerdFilter:setHerdFilter, changeRole:changeRole, removeMember:removeMember,
    openTaskModal:openTaskModal, deleteTask:deleteTask, completeTask:completeTask
  };

})();
