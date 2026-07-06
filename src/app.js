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

  var FS_COLLECTION = {rabbits:'rabbits', cages:'cages', litters:'litters', health:'health', feedStock:'feedStock', ledger:'ledger', tasks:'tasks', taskLogs:'taskLogs'};

  var currentUser = null;
  var farms = [];
  var currentFarm = null; // {id,name,currency,role}
  var currentRole = 'viewer';
  var state = {rabbits:[], cages:[], litters:[], health:[], feedStock:[], ledger:[], tasks:[], taskLogs:[]};
  var current = 'dashboard';
  var GEST_DAYS = 31;
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
    if(action === 'open-health-modal') return openHealthModal();
    if(action === 'open-cage-modal') return openCageModal(target.dataset.id || null);
    if(action === 'delete-cage') return deleteCage(target.dataset.id);
    if(action === 'open-feed-item-modal') return openFeedItemModal(target.dataset.id || null);
    if(action === 'open-feed-adjust-modal') return openFeedAdjustModal(target.dataset.id, target.dataset.kind);
    if(action === 'delete-feed-item') return deleteFeedItem(target.dataset.id);
    if(action === 'open-ledger-modal') return openLedgerModal();
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
    currentFarm = farm; currentRole = farm.role; appScreen='app'; current='dashboard';
    renderRoot();
    await loadFarmData();
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
  async function completeTaskApi(taskId){
    var completeTaskFn = fx.httpsCallable('completeTask');
    await completeTaskFn({farmId: currentFarm.id, taskId: taskId});
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

  function viewTasks(){
    var rows = state.tasks.slice().sort(function(a,b){return a.name.localeCompare(b.name);});
    return '<div class="w-headrow"><div><h2>Tasks</h2><div class="w-sub">Record and schedule daily, weekly, and monthly activities.</div></div>'+ 
      (can('worker')?'<button class="w-btn w-btn-primary"'+clickAttrs('open-task-modal')+'>+ Add task</button>':'')+'</div>'+ 
      '<div class="w-panel">'+(rows.length? taskTable(rows) : '<div class="w-empty"><p>No tasks created yet.</p></div>')+'</div>'+ 
      '<div class="w-panel"><h3>Recent task activity</h3>'+ taskLogsPanel() +'</div>';
  }

  function taskTable(rows){
    return '<table class="w-table"><thead><tr><th>Task</th><th>Frequency</th><th>Next due</th><th>Notes</th><th>Action</th></tr></thead><tbody>'+ 
      rows.map(function(t){
        return '<tr><td>'+esc(t.name)+'</td><td>'+esc(t.frequency)+'</td><td class="mono">'+esc(t.nextDue||t.dueDate||'—')+'</td><td style="color:var(--ink-muted);">'+esc(t.notes||'')+'</td>'+ 
          '<td style="white-space:nowrap;">'+
            (can('worker')? '<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('complete-task', {id:t.id})+'>Mark done</button> <button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('open-task-modal', {id:t.id})+'>Edit</button>' : '—')+
          '</td></tr>';
      }).join('')+'</tbody></table>';
  }

  function openTaskModal(id){
    var t = id ? state.tasks.find(function(x){return x.id===id;}) : null;
    var html = '<div class="w-modal"><h3>'+(t?'Edit task':'Add task')+'</h3><form id="w-task-form">'+
      '<div class="w-row2"><div class="w-field"><label>Task name</label><input name="name" required value="'+esc(t?t.name:'')+'"/></div>'+ 
      '<div class="w-field"><label>Frequency</label><select name="frequency">'+
        ['daily','weekly','monthly'].map(function(freq){return '<option value="'+freq+'" '+(t&&t.frequency===freq?'selected':'')+'>'+freq.charAt(0).toUpperCase()+freq.slice(1)+'</option>';}).join('')+
      '</select></div></div>'+ 
      '<div class="w-row2"><div class="w-field"><label>Next due</label><input type="date" name="nextDue" value="'+esc(t?t.nextDue:'')+'"/></div>'+ 
      '<div class="w-field"><label>Notes</label><input name="notes" value="'+esc(t?t.notes:'')+'"/></div></div>'+ 
      '<div class="w-modalfoot">'+(t&&can('supervisor')?'<button type="button" class="w-btn w-btn-danger"'+clickAttrs('delete-task', {id:t.id})+'>Delete</button>':'<span></span>')+ 
      '<span style="flex:1"></span><button type="button" class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Cancel</button>'+ 
      '<button type="submit" class="w-btn w-btn-primary">Save task</button></div></form></div>';
    showModal(html);
    document.getElementById('w-task-form').onsubmit = async function(e){
      e.preventDefault(); var f = new FormData(e.target);
      var body = {name:f.get('name'), frequency:f.get('frequency'), nextDue:f.get('nextDue')||null, notes:f.get('notes')};
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
    return '<table class="w-table"><thead><tr><th>Date</th><th>Task</th><th>By</th><th>Frequency</th></tr></thead><tbody>'+
      logs.map(function(log){
        return '<tr><td class="mono">'+fmtDate(log.completedAt)+'</td><td>'+esc(log.taskName)+'</td><td>'+esc(log.completedBy || '—')+'</td><td>'+esc(log.frequency)+'</td></tr>';
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
      await completeTaskApi(id);
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
    var dueTaskCount = state.tasks.filter(function(t){ var due = t.nextDue || t.dueDate; return due && daysFromToday(due) <= 0; }).length;
    var overdueTaskCount = state.tasks.filter(function(t){ var due = t.nextDue || t.dueDate; return due && daysFromToday(due) < 0; }).length;
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

  function herdTable(rows){
    return '<table class="w-table"><thead><tr><th>Tag</th><th>Name</th><th>Breed</th><th>Sex</th><th>DOB</th><th>Status</th><th>Hutch</th><th></th></tr></thead><tbody>'+
      rows.map(function(r){
        var cage = cageById(r.cageId);
        return '<tr><td>'+eartag(r)+'</td><td><span class="w-link"'+clickAttrs('open-rabbit-detail', {id:r.id})+'>'+esc(r.name)+'</span></td>'+
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
  function cageOptions(selectedId){
    return '<option value="">— unassigned —</option>'+state.cages.map(function(c){return '<option value="'+c.id+'" '+(c.id===selectedId?'selected':'')+'>'+esc(c.label)+'</option>';}).join('');
  }

  function openRabbitModal(id){
    var r = id ? rabbitById(id) : null;
    var nextTag = 'R-'+String(state.rabbits.length+1).padStart(3,'0');
    var html = '<div class="w-modal"><h3>'+(r?'Edit rabbit':'Add rabbit')+'</h3><form id="w-rabbit-form">'+
      '<div class="w-row2"><div class="w-field"><label>Ear tag</label><input name="tag" required value="'+esc(r?r.tag:nextTag)+'"/></div>'+
      '<div class="w-field"><label>Name</label><input name="name" required value="'+esc(r?r.name:'')+'"/></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Breed</label><input name="breed" list="w-breeds" value="'+esc(r?r.breed:'')+'"/>'+
        '<datalist id="w-breeds"><option>New Zealand White</option><option>Californian</option><option>Flemish Giant</option><option>Rex</option><option>Dutch</option><option>Mini Lop</option><option>English Angora</option><option>Chinchilla</option></datalist></div>'+
      '<div class="w-field"><label>Sex</label><select name="sex"><option value="doe" '+(r&&r.sex==='doe'?'selected':'')+'>Doe (female)</option><option value="buck" '+(r&&r.sex==='buck'?'selected':'')+'>Buck (male)</option></select></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Date of birth</label><input type="date" name="dob" value="'+esc(r?r.dob:'')+'"/></div>'+
      '<div class="w-field"><label>Status</label><select name="status"><option value="active" '+(!r||r.status==='active'?'selected':'')+'>Active</option><option value="retired" '+(r&&r.status==='retired'?'selected':'')+'>Retired</option><option value="sold" '+(r&&r.status==='sold'?'selected':'')+'>Sold</option><option value="deceased" '+(r&&r.status==='deceased'?'selected':'')+'>Deceased</option></select></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Sire (father)</label><select name="sireId">'+rabbitOptions(r?r.sireId:'', r?r.id:null,'buck')+'</select></div>'+
      '<div class="w-field"><label>Dam (mother)</label><select name="damId">'+rabbitOptions(r?r.damId:'', r?r.id:null,'doe')+'</select></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Hutch</label><select name="cageId">'+cageOptions(r?r.cageId:'')+'</select></div>'+
      '<div class="w-field"><label>Weight (lb)</label><input type="number" step="0.1" name="weight" value="'+(r&&r.weight!=null?r.weight:'')+'"/></div></div>'+
      '<div class="w-field"><label>Notes</label><textarea name="notes">'+esc(r?r.notes:'')+'</textarea></div>'+
      '<div class="w-modalfoot">'+(r&&can('supervisor')?'<button type="button" class="w-btn w-btn-danger"'+clickAttrs('delete-rabbit', {id:r.id})+'>Delete</button>':'<span></span>')+
      '<span style="flex:1"></span><button type="button" class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Cancel</button>'+
      '<button type="submit" class="w-btn w-btn-primary">Save rabbit</button></div></form></div>';
    showModal(html);
    document.getElementById('w-rabbit-form').onsubmit = async function(e){
      e.preventDefault(); var f = new FormData(e.target);
      var body = {tag:f.get('tag'), name:f.get('name'), breed:f.get('breed'), sex:f.get('sex'), dob:f.get('dob')||null,
        status:f.get('status'), sireId:f.get('sireId')||null, damId:f.get('damId')||null, cageId:f.get('cageId')||null,
        weight:f.get('weight')?parseFloat(f.get('weight')):null, notes:f.get('notes')};
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
    var cage = cageById(r.cageId);
    var recs = state.health.filter(function(h){return h.rabbitId===id;}).sort(function(a,b){return new Date(b.date)-new Date(a.date);});
    var html = '<div class="w-modal" style="max-width:560px;">'+
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;"><h3>'+esc(r.name)+' '+eartag(r)+'</h3>'+statusPill(r.status)+'</div>'+
      '<div class="w-detailgrid" style="margin-top:12px;">'+det('Breed', r.breed)+det('Sex', r.sex)+det('Born', fmtDate(r.dob))+det('Weight', r.weight?r.weight+' lb':'—')+det('Hutch', cage?cage.label:'Unassigned')+det('Sire', sire?sire.tag+' — '+sire.name:'Unknown')+det('Dam', dam?dam.tag+' — '+dam.name:'Unknown')+'</div>'+
      (sire||dam? ('<div style="margin-top:6px;padding-top:10px;border-top:1px solid var(--line);"><div class="k" style="font-size:.72rem;text-transform:uppercase;color:var(--ink-muted);letter-spacing:.5px;margin-bottom:6px;">Grandparents</div><div class="w-detailgrid">'+det("Sire's sire", grand(sire,'sireId'))+det("Sire's dam", grand(sire,'damId'))+det("Dam's sire", grand(dam,'sireId'))+det("Dam's dam", grand(dam,'damId'))+'</div></div>') : '')+
      (r.notes? '<div style="margin-top:10px;font-size:.85rem;color:var(--ink-muted);"><em>'+esc(r.notes)+'</em></div>':'')+
      '<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--line);"><div class="k" style="font-size:.72rem;text-transform:uppercase;color:var(--ink-muted);letter-spacing:.5px;margin-bottom:6px;">Health history</div>'+
      (recs.length? recs.map(function(h){return '<div style="font-size:.82rem;padding:4px 0;">'+fmtDate(h.date)+' — <b>'+esc(h.type)+'</b> '+esc(h.description||'')+'</div>';}).join('') : '<div style="font-size:.82rem;color:var(--ink-muted);">No health records yet.</div>')+'</div>'+
      '<div class="w-modalfoot"><button class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Close</button>'+(can('worker')?'<button class="w-btn w-btn-primary"'+clickAttrs('edit-rabbit-from-detail', {id:r.id})+'>Edit</button>':'')+'</div>'+
    '</div>';
    showModal(html);
  }
  function det(k,v){ return '<div><div class="k">'+k+'</div><div>'+esc(v)+'</div></div>'; }
  function grand(parent, key){ if(!parent || !parent[key]) return 'Unknown'; var g = rabbitById(parent[key]); return g ? g.tag+' — '+g.name : 'Unknown'; }

  // ============ BREEDING ============
  function viewBreeding(){
    var rows = state.litters.slice().sort(function(a,b){return new Date(b.matingDate)-new Date(a.matingDate);});
    return '<div class="w-headrow"><div><h2>Breeding</h2><div class="w-sub">'+state.litters.length+' pairings recorded</div></div>'+
      (can('worker')?'<button class="w-btn w-btn-primary"'+clickAttrs('open-litter-modal')+'>+ Record pairing</button>':'')+'</div>'+
      '<div class="w-panel">'+(rows.length? litterTable(rows) : '<div class="w-empty"><p>No breedings recorded yet.</p></div>')+'</div>';
  }
  function litterStatus(l){
    if(l.weanDate) return {label:'Weaned',cls:'pill-moss'};
    if(l.kindleDate) return {label:'Nursing',cls:'pill-clay'};
    return {label:'Expecting',cls:'pill-warn'};
  }
  function litterTable(rows){
    return '<table class="w-table"><thead><tr><th>Doe</th><th>Buck</th><th>Mated</th><th>Due / Kindled</th><th>Kits</th><th>Status</th><th></th></tr></thead><tbody>'+
      rows.map(function(l){
        var doe=rabbitById(l.doeId), buck=rabbitById(l.buckId), st=litterStatus(l);
        return '<tr><td>'+(doe?eartag(doe)+' '+esc(doe.name):'—')+'</td><td>'+(buck?eartag(buck)+' '+esc(buck.name):'—')+'</td>'+
          '<td class="mono" style="font-size:.78rem;">'+fmtDate(l.matingDate)+'</td>'+
          '<td class="mono" style="font-size:.78rem;">'+(l.kindleDate?fmtDate(l.kindleDate):fmtDate(l.dueDate)+' (due)')+'</td>'+
          '<td>'+(l.kitsBorn!=null? l.kitsBorn+' born, '+(l.kitsAlive!=null?l.kitsAlive:l.kitsBorn)+' alive' : '—')+'</td>'+
          '<td><span class="w-pill '+st.cls+'">'+st.label+'</span></td>'+
            '<td>'+(can('worker')?'<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('open-litter-modal', {id:l.id})+'>Update</button>':'')+'</td></tr>';
      }).join('')+'</tbody></table>';
  }
  function openLitterModal(id){
    var l = id ? state.litters.find(function(x){return x.id===id;}) : null;
    var html = '<div class="w-modal"><h3>'+(l?'Update pairing':'Record pairing')+'</h3><form id="w-litter-form">'+
      '<div class="w-row2"><div class="w-field"><label>Doe</label><select name="doeId" required>'+rabbitOptions(l?l.doeId:'', null,'doe')+'</select></div>'+
      '<div class="w-field"><label>Buck</label><select name="buckId" required>'+rabbitOptions(l?l.buckId:'', null,'buck')+'</select></div></div>'+
      '<div class="w-field"><label>Mating date</label><input type="date" name="matingDate" required value="'+esc(l?l.matingDate:todayStr())+'"/></div>'+
      '<div class="w-row2"><div class="w-field"><label>Kindle date (if born)</label><input type="date" name="kindleDate" value="'+esc(l?l.kindleDate:'')+'"/></div>'+
      '<div class="w-field"><label>Wean date (if weaned)</label><input type="date" name="weanDate" value="'+esc(l?l.weanDate:'')+'"/></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Kits born</label><input type="number" name="kitsBorn" value="'+(l&&l.kitsBorn!=null?l.kitsBorn:'')+'"/></div>'+
      '<div class="w-field"><label>Kits alive</label><input type="number" name="kitsAlive" value="'+(l&&l.kitsAlive!=null?l.kitsAlive:'')+'"/></div></div>'+
      '<div class="w-field"><label>Notes</label><textarea name="notes">'+esc(l?l.notes:'')+'</textarea></div>'+
      '<div class="w-modalfoot">'+(l&&can('supervisor')?'<button type="button" class="w-btn w-btn-danger"'+clickAttrs('delete-litter', {id:l.id})+'>Delete</button>':'<span></span>')+
      '<span style="flex:1"></span><button type="button" class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Cancel</button>'+
      '<button type="submit" class="w-btn w-btn-primary">Save</button></div></form></div>';
    showModal(html);
    document.getElementById('w-litter-form').onsubmit = async function(e){
      e.preventDefault(); var f = new FormData(e.target); var matingDate = f.get('matingDate');
      var body = {doeId:f.get('doeId'), buckId:f.get('buckId'), matingDate:matingDate, dueDate:addDays(matingDate, GEST_DAYS),
        kindleDate:f.get('kindleDate')||null, weanDate:f.get('weanDate')||null,
        kitsBorn:f.get('kitsBorn')?parseInt(f.get('kitsBorn')):null, kitsAlive:f.get('kitsAlive')?parseInt(f.get('kitsAlive')):null,
        notes:f.get('notes')};
      try{ if(l) await updateItem('litters', l.id, body); else await createItem('litters', body); closeModal(); renderMain(); showToast('Breeding record saved'); }
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
        return '<tr><td class="mono" style="font-size:.78rem;">'+fmtDate(h.date)+'</td><td>'+(r?eartag(r)+' '+esc(r.name):'—')+'</td>'+
          '<td>'+esc(h.type)+(h.weight?' ('+h.weight+' lb)':'')+'</td><td style="color:var(--ink-muted);">'+esc(h.description||'—')+'</td>'+
          '<td class="mono" style="font-size:.78rem;">'+(h.nextDue?fmtDate(h.nextDue):'—')+'</td></tr>';
      }).join('')+'</tbody></table>';
  }
  function openHealthModal(){
    var html = '<div class="w-modal"><h3>Log health record</h3><form id="w-health-form">'+
      '<div class="w-field"><label>Rabbit</label><select name="rabbitId" required>'+rabbitOptions('',null,null)+'</select></div>'+
      '<div class="w-row2"><div class="w-field"><label>Date</label><input type="date" name="date" required value="'+todayStr()+'"/></div>'+
      '<div class="w-field"><label>Type</label><select name="type"><option>Vaccination</option><option>Treatment</option><option>Checkup</option><option>Weight log</option></select></div></div>'+
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
    return '<div class="w-headrow"><div><h2>Housing</h2><div class="w-sub">'+state.cages.length+' hutches</div></div>'+
      (can('worker')?'<button class="w-btn w-btn-primary"'+clickAttrs('open-cage-modal')+'>+ Add hutch</button>':'')+'</div>'+
      (state.cages.length? '<div class="w-stats">'+state.cages.map(function(c){
        var occ = active.filter(function(r){return r.cageId===c.id;});
        var over = occ.length>c.capacity;
        return '<div class="w-panel" style="margin-bottom:0;"><div style="display:flex;justify-content:space-between;align-items:flex-start;"><h3 style="border:none;padding:0;font-size:.95rem;">'+esc(c.label)+'</h3>'+
          (can('worker')?'<button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('open-cage-modal', {id:c.id})+'>Edit</button>':'')+'</div>'+
          '<div style="font-size:.78rem;color:var(--ink-muted);margin-bottom:8px;">'+esc(c.location||'')+'</div>'+
          '<div class="mono" style="font-size:1.1rem;font-weight:700;color:'+(over?'var(--warn)':'var(--moss)')+';">'+occ.length+' / '+c.capacity+'</div>'+
          '<div style="font-size:.72rem;color:var(--ink-muted);margin-bottom:6px;">occupants</div>'+
          (occ.length? occ.map(function(r){return eartag(r);}).join(' ') : '<span style="font-size:.78rem;color:var(--grey);">Empty</span>')+'</div>';
      }).join('')+'</div>' : '<div class="w-panel w-empty"><p>No hutches set up yet.</p></div>');
  }
  function openCageModal(id){
    var c = id ? cageById(id) : null;
    var html = '<div class="w-modal"><h3>'+(c?'Edit hutch':'Add hutch')+'</h3><form id="w-cage-form">'+
      '<div class="w-field"><label>Label</label><input name="label" required value="'+esc(c?c.label:'')+'" placeholder="e.g. Row A-3"/></div>'+
      '<div class="w-row2"><div class="w-field"><label>Location</label><input name="location" value="'+esc(c?c.location:'')+'" placeholder="e.g. North barn"/></div>'+
      '<div class="w-field"><label>Capacity</label><input type="number" name="capacity" min="1" value="'+(c?c.capacity:1)+'"/></div></div>'+
      '<div class="w-modalfoot">'+(c&&can('supervisor')?'<button type="button" class="w-btn w-btn-danger"'+clickAttrs('delete-cage', {id:c.id})+'>Delete</button>':'<span></span>')+
      '<span style="flex:1"></span><button type="button" class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Cancel</button>'+
      '<button type="submit" class="w-btn w-btn-primary">Save</button></div></form></div>';
    showModal(html);
    document.getElementById('w-cage-form').onsubmit = async function(e){
      e.preventDefault(); var f = new FormData(e.target);
      var body = {label:f.get('label'), location:f.get('location'), capacity:parseInt(f.get('capacity'))||1};
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
  function viewLedger(){
    var rows = state.ledger.slice().sort(function(a,b){return new Date(b.date)-new Date(a.date);});
    var income = state.ledger.filter(function(e){return e.type==='Sale';}).reduce(function(s,e){return s+Number(e.amount);},0);
    var expense = state.ledger.filter(function(e){return e.type!=='Sale';}).reduce(function(s,e){return s+Number(e.amount);},0);
    return '<div class="w-headrow"><div><h2>Ledger</h2><div class="w-sub">Sales, feed &amp; expenses in '+esc(currentFarm.currency)+'</div></div>'+
      (can('worker')?'<button class="w-btn w-btn-primary"'+clickAttrs('open-ledger-modal')+'>+ Add entry</button>':'')+'</div>'+
      '<div class="w-stats">'+stat(money(income),'Income')+stat(money(expense),'Expenses')+stat(money(income-expense),'Net')+'</div>'+
      '<div class="w-panel">'+(rows.length? ledgerTable(rows) : '<div class="w-empty"><p>No ledger entries yet.</p></div>')+'</div>';
  }
  function ledgerTable(rows){
    return '<table class="w-table"><thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Rabbit</th><th>Amount</th><th>Notes</th></tr></thead><tbody>'+
      rows.map(function(e){
        var r = e.rabbitId?rabbitById(e.rabbitId):null;
        return '<tr><td class="mono" style="font-size:.78rem;">'+fmtDate(e.date)+'</td><td><span class="w-pill '+(e.type==='Sale'?'pill-moss':'pill-clay')+'">'+esc(e.type)+'</span></td>'+
          '<td>'+esc(e.category)+'</td><td>'+(r?eartag(r):'—')+'</td><td class="mono">'+money(e.amount)+'</td><td style="color:var(--ink-muted);">'+esc(e.notes||'')+'</td></tr>';
      }).join('')+'</tbody></table>';
  }
  function openLedgerModal(){
    var html = '<div class="w-modal"><h3>Add ledger entry</h3><form id="w-ledger-form">'+
      '<div class="w-row2"><div class="w-field"><label>Date</label><input type="date" name="date" required value="'+todayStr()+'"/></div>'+
      '<div class="w-field"><label>Type</label><select name="type"><option>Sale</option><option>Expense</option><option>Feed</option></select></div></div>'+
      '<div class="w-row2"><div class="w-field"><label>Category</label><input name="category" placeholder="e.g. Pellet feed, Vet visit, Rabbit sale" required/></div>'+
      '<div class="w-field"><label>Amount ('+esc(currentFarm.currency)+')</label><input type="number" step="0.01" name="amount" required/></div></div>'+
      '<div class="w-field"><label>Related rabbit (optional)</label><select name="rabbitId">'+rabbitOptions('',null,null)+'</select></div>'+
      '<div class="w-field"><label>Notes</label><textarea name="notes"></textarea></div>'+
      '<div class="w-modalfoot"><span style="flex:1"></span><button type="button" class="w-btn w-btn-ghost"'+clickAttrs('close-modal')+'>Cancel</button>'+
      '<button type="submit" class="w-btn w-btn-primary">Save entry</button></div></form></div>';
    showModal(html);
    document.getElementById('w-ledger-form').onsubmit = async function(e){
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
      var snap = await db.collection('farms').doc(currentFarm.id).collection('members').get();
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
    return '<div class="w-headrow"><div><h2>Team</h2><div class="w-sub">Who has access to '+esc(currentFarm.name)+'</div></div></div>'+
      (memberNotice? '<div class="w-notice-banner"><div><b>'+esc(memberNotice.title||'Notice')+'</b><div>'+esc(memberNotice.detail||memberNotice.message)+'</div></div><button type="button" class="w-notice-close"'+clickAttrs('dismiss-member-notice')+'>×</button></div>' : '')+
      (can('farm_manager')? ('<div class="w-panel"><h3>Farm settings</h3><form id="w-farmsettings-form" class="w-row2">'+
        '<div class="w-field"><label>Farm name</label><input name="name" value="'+esc(currentFarm.name)+'"/></div>'+
        '<div class="w-field"><label>Currency</label><select name="currency">'+CURRENCIES.map(function(c){return '<option value="'+c+'" '+(c===currentFarm.currency?'selected':'')+'>'+c+'</option>';}).join('')+'</select></div>'+
        '<div style="grid-column:1/-1;"><button type="submit" class="w-btn w-btn-primary">Save farm settings</button></div>'+
      '</form></div>') : '')+
      (can('farm_manager')? ('<div class="w-panel"><h3>Add a team member</h3><div class="w-sub" style="margin-bottom:10px;">If the member does not yet have an account, the app will create one and issue a temporary PIN.</div><form id="w-addmember-form" class="w-row2">'+
        '<div class="w-field"><label>Email</label><input type="email" name="email" required/></div>'+
        '<div class="w-field"><label>Role</label><select name="role">'+roleOpts.map(function(r){return '<option value="'+r+'">'+r.replace('_',' ')+'</option>';}).join('')+'</select></div>'+
        '<div style="grid-column:1/-1;"><button type="submit" class="w-btn w-btn-primary">Add member</button></div>'+
      '</form></div>') : '')+
      '<div class="w-panel"><h3>Members ('+teamMembers.length+')</h3>'+
        (teamMembers.length? ('<div class="w-member-list">'+
          teamMembers.map(function(m){
            return '<div class="w-member-card">'+
              '<div class="w-member-top">'+
                '<div class="w-member-info">'+
                  '<div class="w-member-name">'+esc(m.name||'—')+'</div>'+
                  '<div class="w-member-meta mono">'+esc(m.email)+'</div>'+
                '</div>'+
                '<div>'+(can('farm_manager')? ('<select'+changeAttrs('change-role', {uid:m.uid})+'>'+roleOpts.map(function(r){return '<option value="'+r+'" '+(r===m.role?'selected':'')+'>'+r.replace('_',' ')+'</option>';}).join('')+'</select>') : ('<span class="w-pill pill-moss">'+m.role.replace('_',' ')+'</span>'))+'</div>'+
              '</div>'+
              (can('farm_manager')? ('<div class="w-member-actions"><button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('show-member-pin', {uid:m.uid, email:m.email})+'>Show PIN</button><button class="w-btn w-btn-ghost w-btn-sm"'+clickAttrs('resend-setup-email', {uid:m.uid, email:m.email})+'>Resend setup</button><button class="w-btn w-btn-danger w-btn-sm"'+clickAttrs('remove-member', {uid:m.uid})+'>Remove</button></div>') : '')+
            '</div>';
          }).join('')+'</div>') : '<div class="w-empty"><p>No members loaded.</p></div>')+
      '</div>';
  }
  async function handleFarmSettingsSubmit(e){
    e.preventDefault(); var f = new FormData(e.target);
    var name = f.get('name'), currency = f.get('currency');
    try{
      var updateFn = fx.httpsCallable('updateFarmSettings');
      var res = await updateFn({farmId:currentFarm.id, name:name, currency:currency});
      var farm = res.data || {};
      currentFarm.name = farm.name || name; currentFarm.currency = farm.currency || currency;
      var fi = farms.findIndex(function(x){return x.id===currentFarm.id;});
      if(fi>-1){ farms[fi].name=currentFarm.name; farms[fi].currency=currentFarm.currency; }
      renderRoot(); showToast('Farm settings saved');
    }catch(err){ showToast(friendlyError(err), true); }
  }
  async function handleAddMemberSubmit(e){
    e.preventDefault(); var f = new FormData(e.target);
    var email = String(f.get('email')||'').trim();
    try{
      var addFn = fx.httpsCallable('addFarmMember');
      var res = await addFn({farmId:currentFarm.id, email:email, role:f.get('role')});
      if (res.data && res.data.newAccount) {
        var detail = 'Share the temporary PIN with the new user and ask them to sign in. The PIN should be given to the user profile before they set a new password. Temporary PIN: ' + (res.data.tempPin || '—') + '.';
        if (res.data.emailSent === false) detail += ' If the setup email does not arrive, use the Show PIN helper to share it directly.';
        memberNotice = {title:'Temporary PIN created', detail:detail};
      } else {
        memberNotice = null;
        showToast('Member added');
      }
      loadAndRenderTeam();
    }catch(err){ showToast(friendlyError(err), true); }
  }
  async function changeRole(uid, role){
    try{
      var changeRoleFn = fx.httpsCallable('updateMemberRole');
      await changeRoleFn({farmId:currentFarm.id, uid:uid, role:role});
      showToast('Role updated'); loadAndRenderTeam();
    }catch(err){ showToast(friendlyError(err), true); loadAndRenderTeam(); }
  }
  async function showMemberPin(uid, email){
    if(!uid){ showToast('No member selected.', true); return; }
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
    try{
      var resendFn = fx.httpsCallable('resendSetupEmail');
      var res = await resendFn({farmId: currentFarm.id, uid: uid, email: email});
      var detail = 'A setup email was requested for ' + email + '.';
      if (res.data && res.data.tempPin) detail += ' Temporary PIN: ' + res.data.tempPin + '.';
      if (res.data && res.data.emailSent === false) detail += ' If the email does not arrive, use the Show PIN helper to share the temporary PIN directly.';
      memberNotice = {title:'Setup email requested', detail:detail};
      loadAndRenderTeam();
      showToast('Setup email requested');
    }catch(err){ showToast(friendlyError(err), true); }
  }
  async function removeMember(uid){
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
