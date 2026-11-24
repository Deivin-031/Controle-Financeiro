import {firebaseConfig} from './config.js';

const $=id=>document.getElementById(id), app=$('app'), nav=$('nav');
const money=n=>Number(n||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today=()=>new Date().toLocaleDateString('sv-SE');
const uid=()=>crypto.randomUUID();
const monthNow=()=>today().slice(0,7);

let registering=false,user=null,db=null,auth=null,sdk=null,state={accounts:[],items:[],cards:[]},month=monthNow(),page='Início',demo=false,unsub=null,signingOut=false,sessionEpoch=0;
let locked=false,unlocking=false,lockGeneration=0,lastActivity=Date.now(),freshLogin=false;
let pushBusy=false;

const lockDefaults={enabled:true,minutes:0,background:false};
const worker="https://controle-financeiro.davy-dado.workers.dev";
const passkeyOrigin='https://controle-financeiro-4dr.pages.dev';

function lockPrefs(){
  try{
    return {...lockDefaults,...JSON.parse(localStorage.getItem('mf-lock-'+user?.uid)||'{}')};
  }catch{
    return {...lockDefaults};
  }
}

function localTimestamp(v){
  if(!v)return 'Nunca';
  let t=String(v).replace(' ','T');
  if(!/(Z|[+-]\d{2}:?\d{2})$/i.test(t))t+='Z';
  let d=new Date(t);
  return isNaN(d)?String(v):d.toLocaleString('pt-BR');
}

function lockNow(){
  if(!user||demo||locked||!lockPrefs().enabled)return;
  locked=true;
  lockGeneration++;
  showLock();
}

function showLock(){
  nav.hidden=true;
  nav.innerHTML='';
  $('who').textContent='';
  if($('unlock-form'))return;
  app.innerHTML=`<section>
    <h1>Aplicativo bloqueado</h1>
    <p class="muted">Confirme sua identidade para acessar seus dados.</p>
    <form id="unlock-form">
      <label>Senha atual</label>
      <input name="password" type="password" required autocomplete="current-password">
      <button>Desbloquear com senha</button>
    </form>
    ${passkeyAvailable()?'<button id="unlock-pk" class="alt">Desbloquear com biometria / passkey</button>':''}
    <button id="unlock-exit" class="danger">Sair da conta</button>
    <p id="unlock-msg" role="status"></p>
  </section>`;
  $('unlock-form').onsubmit=e=>{
    e.preventDefault();
    let pw=e.target.elements.password.value;
    e.target.reset();
    unlock(false,pw);
  };
  if($('unlock-pk'))$('unlock-pk').onclick=()=>unlock(true);
  $('unlock-exit').onclick=logout;
}

async function unlock(bio,password){
  if(unlocking||!locked||!user)return;
  let u=auth.currentUser,epoch=sessionEpoch,gen=lockGeneration;
  unlocking=true;
  try{
    if(!u||u.uid!==user.uid)throw Error('Sessão inválida');
    if(bio){
      let name=(u.displayName||'').toLowerCase();
      if(!/^[a-z0-9_]{3,30}$/.test(name))throw Error('Usuário indisponível');
      let {options,challengeId}=await backend('/passkey/login/options',{username:name});
      options.challenge=decode64(options.challenge);
      options.allowCredentials=(options.allowCredentials||[]).map(c=>({...c,id:decode64(c.id)}));
      let c=await navigator.credentials.get({publicKey:options});
      if(!c)throw Error('Cancelado');
      let r=await backend('/passkey/login/verify',{username:name,challengeId,response:credentialJSON(c)});
      let claims=JSON.parse(new TextDecoder().decode(decode64(r.token.split('.')[1])));
      if(claims.uid!==u.uid||epoch!==sessionEpoch||auth.currentUser?.uid!==u.uid)throw Error('Sessão alterada');
      await sdk.signInWithCustomToken(auth,r.token);
    }else{
      await sdk.reauthenticateWithCredential(u,sdk.EmailAuthProvider.credential(u.email,password));
    }
    if(epoch!==sessionEpoch||gen!==lockGeneration||auth.currentUser?.uid!==u.uid||document.hidden)throw Error('Sessão alterada');
    locked=false;
    lastActivity=Date.now();
    render();
  }catch(e){
    if($('unlock-msg'))$('unlock-msg').textContent='Não foi possível desbloquear. Tente novamente ou use sua senha.';
  }finally{
    unlocking=false;
  }
}

function lockSettings(){
  let p=lockPrefs();
  return `<section>
    <h2>Bloqueio automático</h2>
    <label><input style="width:auto" id="lock-enabled" type="checkbox" ${p.enabled?'checked':''}> Ativar bloqueio automático</label>
    <label>Bloquear após inatividade</label>
    <select id="lock-minutes">
      ${[0,1,5,15,30].map(n=>`<option value="${n}" ${p.minutes===n?'selected':''}>${n?n+' minuto(s)':'Sem temporizador de inatividade'}</option>`).join('')}
    </select>
    <label><input style="width:auto" id="lock-background" type="checkbox" ${p.background?'checked':''}> Bloquear ao minimizar o aplicativo</label>
    <button id="lock-save">Salvar configuração</button>
    <button class="alt" id="lock-now">Bloquear agora</button>
    <p class="muted">Configuração deste dispositivo. Alterações exigem a senha atual.</p>
  </section>`;
}

function bindLockSettings(){
  if(!$('lock-save'))return;
  $('lock-now').onclick=lockNow;
  $('lock-save').onclick=async()=>{
    let u=auth.currentUser,epoch=sessionEpoch;
    let p={
      enabled:$('lock-enabled').checked,
      minutes:+$('lock-minutes').value,
      background:$('lock-background').checked
    };
    let pw=prompt('Confirme a senha atual para alterar a proteção');
    if(!pw)return;
    try{
      await sdk.reauthenticateWithCredential(u,sdk.EmailAuthProvider.credential(u.email,pw));
      if(epoch!==sessionEpoch||locked||auth.currentUser?.uid!==u.uid)return;
      localStorage.setItem('mf-lock-'+u.uid,JSON.stringify(p));
      lastActivity=Date.now();
      render();
    }catch{
      alert('Não foi possível confirmar a senha.');
    }
  };
}

for(let event of ['pointerdown','keydown','touchstart','scroll']){
  document.addEventListener(event,()=>{
    if(!locked)lastActivity=Date.now();
  },{passive:true,capture:true});
}

function checkLock(){
  if(!user||demo||locked)return;
  let p=lockPrefs();
  if(p.enabled&&((document.hidden&&p.background)||(p.minutes>0&&Date.now()-lastActivity>=p.minutes*60000)))lockNow();
}

document.addEventListener('visibilitychange',checkLock);
window.addEventListener('pagehide',()=>{
  if(user&&!demo&&lockPrefs().enabled&&lockPrefs().background)lockNow();
});
window.addEventListener('pageshow',checkLock);
setInterval(checkLock,1000);

const blank=()=>({accounts:[],items:[],cards:[]});

const dateAdd=(d,n)=>{
  let [y,m,day]=d.split('-').map(Number);
  let t=new Date(y,m-1+n,1);
  return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(Math.min(day,new Date(t.getFullYear(),t.getMonth()+1,0).getDate())).padStart(2,'0')}`;
};

function occurrences(until=month){
  return state.items.flatMap(x=>{
    let a=[];
    for(let i=0;i<(x.repeat==='monthly'?120:x.repeat==='installments'?x.count:1);i++){
      let date=dateAdd(x.date,i);
      if(date.slice(0,7)>until)break;
      a.push({...x,date,key:`${x.id}:${i}`,paid:x.payments?.[i],index:i,amount:x.overrides?.[i]??x.amount});
    }
    return a;
  });
}

async function save(){
  if(demo){
    localStorage.setItem('mf-demo',JSON.stringify(state));
    return;
  }
  await sdk.setDoc(sdk.doc(db,'users',user.uid),state);
}

async function change(fn){
  let old=structuredClone(state),epoch=sessionEpoch;
  try{
    fn();
    await save();
    if(epoch===sessionEpoch)render();
  }catch(e){
    if(epoch===sessionEpoch){
      state=old;
      render();
      alert('Não foi possível salvar: '+e.message);
    }
  }
}

function clearSession(){
  locked=false;
  freshLogin=false;
  sessionEpoch++;
  if(unsub){
    unsub();
    unsub=null;
  }
  user=null;
  state=blank();
  demo=false;
  page='Início';
  month=monthNow();
  nav.innerHTML='';
  login();
}

async function logout(){
  if(signingOut)return;
  if(pushBusy){
    alert('Aguarde a operação de notificações terminar.');
    return;
  }
  signingOut=true;
  let wasDemo=demo;
  try{
    if(!wasDemo&&auth?.currentUser){
      await removeDevicePush(auth.currentUser);
    }
  }catch(e){
    signingOut=false;
    alert('Não foi possível desativar as notificações deste dispositivo. Verifique a conexão e tente sair novamente.');
    return;
  }
  clearSession();
  app.innerHTML='<section>Encerrando sessão...</section>';
  try{
    if(!wasDemo&&auth)await sdk.signOut(auth);
    login();
  }catch(e){
    login();
    $('msg').textContent='Não foi possível encerrar a sessão. Tente novamente.';
    let retry=document.createElement('button');
    retry.textContent='Tentar sair novamente';
    retry.onclick=logout;
    app.prepend(retry);
    $('login').querySelector('button').disabled=true;
  }finally{
    signingOut=false;
  }
}

async function backend(path,body,token){
  const r=await fetch(worker+path,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      ...(token?{Authorization:"Bearer "+token}:{})
    },
    body:JSON.stringify(body)
  });
  const j=await r.json();
  if(!r.ok)throw Error(j.erro||"Serviço indisponível");
  return j;
}

async function claim(u,name){
  return backend("/claim",{username:name},await u.getIdToken());
}

const passkeyAvailable=()=>location.origin===passkeyOrigin&&!!window.PublicKeyCredential&&!!navigator.credentials;
const decode64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const encode64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

function credentialJSON(c){
  if(c.toJSON)return c.toJSON();
  let r=c.response;
  return {
    id:c.id,
    rawId:encode64(c.rawId),
    type:c.type,
    authenticatorAttachment:c.authenticatorAttachment,
    clientExtensionResults:c.getClientExtensionResults(),
    response:{
      clientDataJSON:encode64(r.clientDataJSON),
      ...(r.attestationObject?{
        attestationObject:encode64(r.attestationObject),
        transports:r.getTransports?.()||[]
      }:{
        authenticatorData:encode64(r.authenticatorData),
        signature:encode64(r.signature),
        userHandle:r.userHandle?encode64(r.userHandle):null
      })
    }
  };
}

// NOTIFICAÇÕES REMOTAS

function pushAvailable(){
  return location.origin===passkeyOrigin &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
}

async function pushRegistration(){
  if(!pushAvailable())throw Error('Notificações indisponíveis neste dispositivo.');
  let timer;
  try{
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('O serviço de notificações ainda não está pronto. Reabra o aplicativo.')),10000);
      })
    ]);
  }finally{
    clearTimeout(timer);
  }
}

async function removeDevicePush(u){
  if(!pushAvailable())return;
  let reg=await navigator.serviceWorker.getRegistration();
  if(!reg)return;
  let sub=await reg.pushManager.getSubscription();
  if(!sub)return;
  await backend('/push/unsubscribe',{
    endpoint:sub.endpoint
  },await u.getIdToken());
  await sub.unsubscribe();
}

function pushSettings(){
  return `<section>
    <h2>Notificações</h2>
    <p class="muted">Receba notificações mesmo com o aplicativo fechado.</p>
    <button id="push-enable">Ativar notificações</button>
    <button class="alt" id="push-test">Enviar notificação de teste</button>
    <button class="danger" id="push-disable">Desativar notificações</button>
    <p id="push-msg" role="status"></p>
    <p class="muted">Configuração deste dispositivo. Os lembretes automáticos serão disponibilizados após os testes.</p>
  </section>`;
}

function bindPushSettings(){
  if(!$('push-enable'))return;

  const buttons=['push-enable','push-test','push-disable'];

  if(!pushAvailable()){
    buttons.forEach(id=>$(id).disabled=true);
    $('push-msg').textContent='Este dispositivo não oferece suporte às notificações remotas.';
    return;
  }

  buttons.forEach(id=>$(id).disabled=pushBusy);

  async function run(action){
    if(pushBusy||locked||demo||signingOut)return;

    const u=auth?.currentUser;
    const epoch=sessionEpoch;
    const generation=lockGeneration;
    const msg=$('push-msg');

    if(!u||u.uid!==user?.uid)return;

    function checkSession(){
      if(epoch!==sessionEpoch||
        generation!==lockGeneration||
        locked||signingOut||
        auth.currentUser?.uid!==u.uid){
        throw Error('Sessão alterada. Tente novamente.');
      }
    }

    pushBusy=true;
    buttons.forEach(id=>{
      if($(id))$(id).disabled=true;
    });

    try{
      if(action==='enable'){
        let permission=await Notification.requestPermission();

        if(permission!=='granted'){
          throw Error('Permissão não concedida. Confira as configurações do dispositivo.');
        }

        checkSession();
        msg.textContent='Cadastrando dispositivo...';

        const reg=await pushRegistration();
        const token=await u.getIdToken();
        const result=await backend('/push/public-key',{},token);

        checkSession();

        if(!result.key)throw Error('Chave de notificações indisponível.');

        let sub=await reg.pushManager.getSubscription();

        if(!sub){
          sub=await reg.pushManager.subscribe({
            userVisibleOnly:true,
            applicationServerKey:decode64(result.key)
          });
        }

        try{
          checkSession();
          await backend('/push/subscribe',{
            subscription:sub.toJSON()
          },await u.getIdToken());
          checkSession();
        }catch(e){
          await sub.unsubscribe().catch(()=>{});
          throw e;
        }

        msg.textContent='Notificações ativadas neste dispositivo!';
      }

      if(action==='test'){
        const reg=await pushRegistration();
        const sub=await reg.pushManager.getSubscription();

        if(!sub)throw Error('Ative as notificações primeiro.');

        checkSession();
        msg.textContent='Enviando notificação de teste...';

        await backend('/push/test',{
          endpoint:sub.endpoint
        },await u.getIdToken());

        checkSession();
        msg.textContent='Notificação encaminhada. Confira o dispositivo.';
      }

      if(action==='disable'){
        checkSession();
        await removeDevicePush(u);
        msg.textContent='Notificações desativadas neste dispositivo.';
      }

    }catch(e){
      msg.textContent='Não foi possível concluir: '+e.message;
    }finally{
      pushBusy=false;
      buttons.forEach(id=>{
        if($(id))$(id).disabled=false;
      });
    }
  }

  $('push-enable').onclick=()=>run('enable');
  $('push-test').onclick=()=>run('test');
  $('push-disable').onclick=()=>run('disable');
}

// BIOMETRIA E PASSKEYS

async function passkeyLogin(){
  let form=$('login'),msg=$('msg'),name=form.elements.username.value.trim().toLowerCase();
  if(!auth||!passkeyAvailable()||!/^[a-z0-9_]{3,30}$/.test(name)){
    msg.textContent='Informe seu nome de usuário e utilize um dispositivo compatível.';
    return;
  }
  let btn=$('passkey-login');
  btn.disabled=true;
  try{
    let {options,challengeId}=await backend('/passkey/login/options',{username:name});
    options.challenge=decode64(options.challenge);
    options.allowCredentials=(options.allowCredentials||[]).map(c=>({...c,id:decode64(c.id)}));
    let c=await navigator.credentials.get({publicKey:options});
    if(!c)throw Error('Operação cancelada');
    let result=await backend('/passkey/login/verify',{username:name,challengeId,response:credentialJSON(c)});
    if(form.elements.remember.checked)localStorage.setItem('mf-user',name);
    else localStorage.removeItem('mf-user');
    freshLogin=true;
    await sdk.signInWithCustomToken(auth,result.token);
  }catch(e){
    freshLogin=false;
    msg.textContent='Não foi possível entrar com a passkey. Use sua senha ou tente novamente.';
  }finally{
    btn.disabled=false;
  }
}

async function managePasskeys(){
  let u=auth?.currentUser;
  if(!u||demo||!passkeyAvailable())return;
  let epoch=sessionEpoch;
  let panel=$('passkey-panel');
  if(!panel)return;
  panel.innerHTML='<p>Carregando passkeys...</p>';
  try{
    let r=await backend('/passkey/list',{},await u.getIdToken());
    if(epoch!==sessionEpoch||!panel.isConnected)return;
    panel.innerHTML='<p>Use a senha atual para cadastrar ou remover uma passkey.</p><label>Senha atual</label><input id="pk-password" type="password" autocomplete="current-password"><label>Nome do dispositivo</label><input id="pk-device" maxlength="100" placeholder="Meu celular"><button id="pk-add">Ativar biometria</button><p id="pk-msg" role="status"></p>'+
      r.credentials.map(c=>`<div class="line"><div><b>${esc(c.device_name)}</b><p class="muted">Cadastro: ${esc(localTimestamp(c.created_at))} · Último uso: ${esc(localTimestamp(c.last_used_at))}</p></div><button class="danger" data-pk="${esc(c.credential_id)}">Remover</button></div>`).join('');

    let run=async(id)=>{
      let msg=$('pk-msg'),pw=$('pk-password'),device=$('pk-device').value;
      let password=pw.value;
      pw.value='';
      if(!password){
        msg.textContent='Informe sua senha atual.';
        return;
      }
      if(id&&!confirm('Remover esta passkey?'))return;
      let buttons=panel.querySelectorAll('button');
      buttons.forEach(b=>b.disabled=true);
      try{
        await sdk.reauthenticateWithCredential(u,sdk.EmailAuthProvider.credential(u.email,password));
        if(epoch!==sessionEpoch||auth.currentUser?.uid!==u.uid)throw Error('Sessão alterada');
        let token=await u.getIdToken(true);
        if(id){
          await backend('/passkey/revoke',{credentialId:id},token);
        }else{
          let {options,challengeId}=await backend('/passkey/register/options',{},token);
          options.challenge=decode64(options.challenge);
          options.user.id=decode64(options.user.id);
          options.excludeCredentials=(options.excludeCredentials||[]).map(c=>({...c,id:decode64(c.id)}));
          let c=await navigator.credentials.create({publicKey:options});
          if(!c||epoch!==sessionEpoch||auth.currentUser?.uid!==u.uid)throw Error('Operação cancelada');
          await backend('/passkey/register/verify',{
            challengeId,
            response:credentialJSON(c),
            deviceName:device
          },await u.getIdToken());
        }
        if(epoch===sessionEpoch&&panel.isConnected)await managePasskeys();
      }catch(e){
        msg.textContent='Não foi possível concluir. Confira a senha, a conexão e a compatibilidade do dispositivo.';
      }finally{
        buttons.forEach(b=>b.disabled=false);
      }
    };
    $('pk-add').onclick=()=>run();
    panel.querySelectorAll('[data-pk]').forEach(b=>b.onclick=()=>run(b.dataset.pk));
  }catch(e){
    panel.textContent='Não foi possível carregar as passkeys. Tente novamente.';
  }
}

// LOGIN E CADASTRO

function login(){
  nav.hidden=true;
  $('who').textContent='';
  app.innerHTML=`<section>
    <h1>Seu dinheiro, sob seu controle</h1>
    <p class="muted">${firebaseConfig?'Entre com seu usuário ou e-mail. Contas antigas: entre pelo e-mail uma vez para vincular o usuário.':'Modo demonstração local. Configure o Firebase para contas individuais online.'}</p>
    <form id="login">
      <label>Usuário ou e-mail</label>
      <input name="username" required value="${esc(localStorage.getItem('mf-user')||'')}" autocomplete="username">
      <label>Senha</label>
      <input name="password" type="password" required autocomplete="current-password">
      <label><input style="width:auto" type="checkbox" name="remember" checked> Lembrar usuário</label>
      <button>Entrar</button>
    </form>
    ${passkeyAvailable()?'<button class="alt" id="passkey-login">Entrar com biometria / passkey</button>':''}
    <button class="alt" id="register">Criar conta</button>
    <button class="alt" id="reset">Recuperar senha</button>
    <button class="alt" id="demo">Experimentar demonstração</button>
    <p id="msg"></p>
  </section>`;

  $('demo').onclick=()=>{
    demo=true;
    user={uid:'demo',displayName:'Demonstração'};
    state=JSON.parse(localStorage.getItem('mf-demo')||'null')||blank();
    render();
  };

  if($('passkey-login'))$('passkey-login').onclick=passkeyLogin;
  $('register').onclick=register;

  $('reset').onclick=async()=>{
    let email=prompt('E-mail cadastrado');
    if(email&&auth){
      try{
        await sdk.sendPasswordResetEmail(auth,email);
        alert('Se a conta existir, você receberá instruções.');
      }catch(e){
        alert(e.message);
      }
    }
  };

  $('login').onsubmit=async e=>{
    e.preventDefault();
    if(!auth)return $('msg').textContent='Configure o Firebase ou use a demonstração.';
    let f=new FormData(e.target),name=f.get('username').trim().toLowerCase();
    try{
      let email=name.includes('@')?name:(await backend('/login',{username:name,password:f.get('password')})).email;
      freshLogin=true;
      let r=await sdk.signInWithEmailAndPassword(auth,email,f.get('password'));
      let alias=r.user.displayName||name;

      if(/^[a-z0-9_]{3,30}$/.test(alias)){
        try{
          await claim(r.user,alias);
        }catch(e){
          alert('Não foi possível vincular o usuário: '+e.message+'. O acesso por e-mail continua disponível.');
        }
      }

      if(f.get('remember')){
        localStorage.setItem('mf-user',alias);
        localStorage.setItem('mf-login',JSON.stringify({name:alias.toLowerCase(),email}));
      }else{
        localStorage.removeItem('mf-user');
        localStorage.removeItem('mf-login');
      }
    }catch(e){
      freshLogin=false;
      if($('msg'))$('msg').textContent='Não foi possível entrar. '+e.message;
    }
  };
}

function register(){
  app.innerHTML=`<form id="reg">
    <h2>Criar conta</h2>
    <label>Nome</label>
    <input name="name" required>
    <label>E-mail</label>
    <input name="email" type="email" required>
    <label>Usuário (letras, números e _)</label>
    <input name="username" pattern="[A-Za-z0-9_]{3,30}" required>
    <label>Senha</label>
    <input name="password" type="password" minlength="8" required>
    <button>Cadastrar</button>
    <button type="button" class="alt" id="back">Voltar</button>
    <p id="msg"></p>
  </form>`;

  $('back').onclick=login;

  $('reg').onsubmit=async e=>{
    e.preventDefault();
    if(!auth)return $('msg').textContent='Firebase não configurado.';
    let f=new FormData(e.target),name=f.get('username').toLowerCase();
    try{
      registering=true;
      let r=await sdk.createUserWithEmailAndPassword(auth,f.get('email'),f.get('password'));
      await sdk.updateProfile(r.user,{displayName:name});
      await sdk.setDoc(sdk.doc(db,'users',r.user.uid),{
        ...blank(),
        profile:{name:f.get('name'),username:name}
      });
      try{
        await claim(r.user,name);
      }catch(e){
        alert('Conta criada, mas o usuário não foi vinculado. Entre pelo e-mail: '+e.message);
      }
      localStorage.setItem('mf-user',name);
      localStorage.setItem('mf-login',JSON.stringify({name,email:r.user.email}));
      registering=false;
      await sdk.signOut(auth);
      login();
      $('msg').textContent='Conta criada. Entre com seu usuário ou e-mail e senha.';
    }catch(e){
      registering=false;
      await sdk.signOut(auth).catch(()=>{});
      login();
      $('msg').textContent=e.message;
    }
  };
}

// INTERFACE FINANCEIRA

function tile(t,v){
  return `<div class="tile"><span class="muted">${t}</span><strong>${money(v)}</strong></div>`;
}

function rows(a){
  return a.length?a.map(x=>`
    <div class="line">
      <div>
        <b>${esc(x.name)}</b>
        <div class="muted">
          ${x.date.split('-').reverse().join('/')} ·
          ${x.paid?'Pago/recebido':x.date<today()?'Atrasado':'Pendente'}
          ${x.repeat==='installments'?`· ${x.index+1}/${x.count}`:''}
        </div>
      </div>
      <div>
        <b>${money(x.amount)}</b>
        <div class="actions">
          <button data-pay="${x.key}">${x.paid?'Desfazer':'Baixar'}</button>
          <button class="alt" data-edit="${x.key}">Editar</button>
        </div>
      </div>
    </div>
  `).join(''):'<p class="muted">Nenhum lançamento.</p>';
}

function render(){
  if(!user)return login();
  if(locked)return showLock();

  $('who').textContent=user.displayName||user.email||'';
  nav.hidden=false;

  nav.innerHTML=['Início','Lançamentos','Bancos','Cartões','Calendário','Relatórios','Ajustes'].map(p=>`<button data-page="${p}">${p}</button>`).join('');

  let all=occurrences(month);
  let a=all.filter(x=>x.date.startsWith(month));
  let sum=(a,type)=>a.filter(x=>x.type===type).reduce((s,x)=>s+x.amount,0);
  let inc=sum(a,'income');
  let out=sum(a,'expense');
  let pending=a.filter(x=>!x.paid);

  let balance=state.accounts.reduce((s,x)=>s+x.balance,0)+occurrences('9999-12').filter(x=>x.paid).reduce((s,x)=>s+(x.type==='income'?1:-1)*x.amount,0);

  let selector=`<label>Mês de referência</label><input id="month" type="month" value="${month}">`;

  if(page==='Início'){
    app.innerHTML=`<h1>Visão financeira</h1>
      ${selector}
      <div class="grid">
        ${tile('Receitas previstas',inc)}
        ${tile('Despesas previstas',out)}
        ${tile('Resultado previsto',inc-out)}
        ${tile('Despesas pagas',out-sum(pending,'expense'))}
        ${tile('Falta pagar',sum(pending,'expense'))}
        ${tile('Saldo registrado',balance)}
      </div>
      <button id="new">+ Novo lançamento</button>
      <section>
        <h2>Próximos vencimentos e atrasados</h2>
        ${rows(all.filter(x=>!x.paid&&x.type==='expense').sort((a,b)=>a.date.localeCompare(b.date)))}
      </section>`;
  }

  if(page==='Lançamentos'){
    app.innerHTML=`<h1>Lançamentos</h1>
      ${selector}
      <button id="new">+ Novo lançamento</button>
      <section>${rows(a.sort((a,b)=>a.date.localeCompare(b.date)))}</section>`;
  }

  if(page==='Bancos'){
    app.innerHTML=`<h1>Contas bancárias</h1>
      <form id="bank">
        <label>Nome da conta</label>
        <input name="name" required>
        <label>Saldo inicial (R$)</label>
        <input name="balance" type="number" step="0.01" required>
        <button>Adicionar conta</button>
      </form>
      <section>
        ${state.accounts.map(b=>`<div class="line">
          <b>${esc(b.name)}</b>
          <strong>${money(b.balance+occurrences('9999-12').filter(x=>x.paid&&x.account===b.id).reduce((s,x)=>s+(x.type==='income'?1:-1)*x.amount,0))}</strong>
        </div>`).join('')}
      </section>`;
  }

  if(page==='Cartões'){
    app.innerHTML=`<h1>Cartões</h1>
      <form id="card">
        <label>Nome</label>
        <input name="name" required>
        <label>Limite</label>
        <input name="limit" type="number" min="0" step="0.01" required>
        <label>Dia de fechamento</label>
        <input name="close" type="number" min="1" max="31" required>
        <label>Dia de vencimento</label>
        <input name="due" type="number" min="1" max="31" required>
        <button>Adicionar cartão</button>
      </form>
      ${selector}
      ${state.cards.map(c=>`<section>
        <h2>${esc(c.name)}</h2>
        <p>Fatura registrada: <b>${money(sum(a.filter(x=>x.card===c.id),'expense'))}</b></p>
        <p>Limite: ${money(c.limit)} · Fecha dia ${c.close} · Vence dia ${c.due}</p>
        <button data-invoice="${c.id}">Registrar fatura</button>
      </section>`).join('')}`;
  }

  if(page==='Calendário'){
    app.innerHTML=`<h1>Calendário financeiro</h1>
      ${selector}
      <section>
        ${Array.from({length:new Date(+month.slice(0,4),+month.slice(5),0).getDate()},(_,i)=>i+1).map(d=>{
          let date=month+'-'+String(d).padStart(2,'0');
          let r=a.filter(x=>x.date===date);
          return `<details ${r.length?'open':''}>
            <summary>${d} · ${r.length} compromisso(s)</summary>
            ${rows(r)}
          </details>`;
        }).join('')}
      </section>`;
  }

  if(page==='Relatórios'){
    app.innerHTML=`<h1>Projeção financeira</h1>
      ${selector}
      <section>
        ${Array.from({length:12},(_,i)=>dateAdd(month+'-01',i).slice(0,7)).map(m=>{
          let r=occurrences(m).filter(x=>x.date.startsWith(m));
          return `<div class="line">
            <b>${m}</b>
            <span>Receitas ${money(sum(r,'income'))}<br>
            Despesas ${money(sum(r,'expense'))}<br>
            Resultado ${money(sum(r,'income')-sum(r,'expense'))}</span>
          </div>`;
        }).join('')}
      </section>`;
  }

  if(page==='Ajustes'){
    app.innerHTML=`<h1>Ajustes</h1>
      <section>
        <p>${demo?'Demonstração local, sem isolamento entre pessoas neste navegador.':'Conta online individual.'}</p>
        <button id="export">Exportar backup JSON</button>
        <button class="danger" id="logout">Sair</button>
      </section>

      ${!demo?pushSettings():''}

      ${!demo&&passkeyAvailable()?'<section><h2>Segurança e biometria</h2><p class="muted">O dispositivo pode solicitar impressão digital, rosto ou PIN.</p><button id="pk-manage">Gerenciar passkeys</button><div id="passkey-panel"></div></section>':''}

      ${!demo?lockSettings():''}`;
  }

  if($('month')){
    $('month').onchange=e=>{
      if(e.target.value){
        month=e.target.value;
        render();
      }
    };
  }

  if($('new'))$('new').onclick=()=>editor();

  if($('bank')){
    $('bank').onsubmit=e=>{
      e.preventDefault();
      let f=new FormData(e.target);
      change(()=>state.accounts.push({
        id:uid(),
        name:f.get('name'),
        balance:+f.get('balance')
      }));
    };
  }

  if($('card')){
    $('card').onsubmit=e=>{
      e.preventDefault();
      let f=Object.fromEntries(new FormData(e.target));
      change(()=>state.cards.push({...f,id:uid(),limit:+f.limit}));
    };
  }

  if($('export')){
    $('export').onclick=()=>{
      let a=document.createElement('a');
      a.href=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));
      a.download='minhas-financas-backup.json';
      a.click();
      URL.revokeObjectURL(a.href);
    };
  }

  if($('logout'))$('logout').onclick=logout;
  if($('pk-manage'))$('pk-manage').onclick=managePasskeys;

  bindLockSettings();
  bindPushSettings();
}

// EDITOR DE LANÇAMENTOS

function editor(x=null,card=null){
  let c=state.cards.find(c=>c.id===card);
  let date=x?.date||(c?dateAdd(month+'-'+String(c.due).padStart(2,'0'),0):today());

  if(c){
    let last=new Date(+month.slice(0,4),+month.slice(5),0).getDate();
    date=month+'-'+String(Math.min(+c.due,last)).padStart(2,'0');
  }

  app.innerHTML=`<form id="entry">
    <h2>${x?'Editar ocorrência':'Novo lançamento'}</h2>
    <label>Descrição</label>
    <input name="name" required value="${esc(x?.name||(c?'Fatura '+c.name:''))}">
    <label>Tipo</label>
    <select name="type">
      <option value="expense">Despesa</option>
      <option value="income" ${x?.type==='income'?'selected':''}>Receita</option>
    </select>
    <label>Valor (R$)</label>
    <input name="amount" type="number" min="0.01" step="0.01" required value="${x?.amount||''}">
    <label>Vencimento</label>
    <input name="date" type="date" required value="${date}" ${x?'disabled':''}>
    <label>Categoria</label>
    <input name="category" value="${esc(x?.category||'')}">
    <label>Conta bancária</label>
    <select name="account">
      <option value="">Sem conta</option>
      ${state.accounts.map(b=>`<option value="${b.id}" ${x?.account===b.id?'selected':''}>${esc(b.name)}</option>`).join('')}
    </select>
    <label>Repetição</label>
    <select name="repeat" ${x?'disabled':''}>
      <option value="once">Única</option>
      <option value="monthly">Mensal</option>
      <option value="installments">Parcelada</option>
    </select>
    <label>Número de parcelas (valor por parcela)</label>
    <input name="count" type="number" min="1" max="120" value="1">
    <button>Salvar</button>
    ${x?'<button type="button" class="danger" id="remove">Excluir série inteira</button>':''}
    <button type="button" class="alt" id="cancel">Cancelar</button>
  </form>`;

  $('cancel').onclick=render;

  if(x){
    $('remove').onclick=()=>{
      if(confirm('Excluir toda a série, inclusive histórico?')){
        change(()=>state.items=state.items.filter(i=>i.id!==x.id));
      }
    };
  }

  $('entry').onsubmit=e=>{
    e.preventDefault();
    let f=Object.fromEntries(new FormData(e.target));

    change(()=>{
      if(x){
        let i=state.items.find(i=>i.id===x.id);
        i.overrides={...i.overrides,[x.index]:+f.amount};
        i.name=f.name;
        i.category=f.category;
        i.account=f.account;
        i.type=f.type;
      }else{
        state.items.push({
          ...f,
          id:uid(),
          amount:+f.amount,
          count:+f.count,
          card:card||null,
          payments:{}
        });
      }
    });
  };
}

nav.onclick=e=>{
  if(e.target.dataset.page){
    page=e.target.dataset.page;
    render();
  }
};

app.addEventListener('click',e=>{
  let d=e.target.dataset;

  if(d.invoice)editor(null,d.invoice);

  if(d.edit){
    let x=occurrences(month).find(x=>x.key===d.edit);
    if(x)editor(x);
  }

  if(d.pay){
    let x=occurrences(month).find(x=>x.key===d.pay);
    if(x){
      change(()=>{
        let i=state.items.find(i=>i.id===x.id);
        i.payments=i.payments||{};
        if(x.paid)delete i.payments[x.index];
        else i.payments[x.index]=today();
      });
    }
  }
});

// INICIALIZAÇÃO

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').catch(console.warn);
}

login();

if(firebaseConfig){
  try{
    let base='https://www.gstatic.com/firebasejs/10.14.1/';

    let [a,b,c]=await Promise.all([
      import(base+'firebase-app.js'),
      import(base+'firebase-auth.js'),
      import(base+'firebase-firestore.js')
    ]);

    sdk={...b,...c};

    let f=a.initializeApp(firebaseConfig);
    auth=b.getAuth(f);
    db=c.getFirestore(f);

    b.onAuthStateChanged(auth,u=>{
      if(signingOut||demo||registering)return;
      if(u&&user?.uid===u.uid)return;

      if(unsub){
        unsub();
        unsub=null;
      }

      sessionEpoch++;
      user=u;
      state=blank();
      page='Início';

      if(u){
        locked=lockPrefs().enabled&&!freshLogin;
        freshLogin=false;
        lastActivity=Date.now();

        if(locked)showLock();

        let epoch=sessionEpoch;

        unsub=c.onSnapshot(
          c.doc(db,'users',u.uid),
          s=>{
            if(epoch!==sessionEpoch||signingOut)return;
            state=s.exists()?s.data():blank();
            render();
          },
          e=>{
            if(epoch===sessionEpoch)alert(e.message);
          }
        );
      }else{
        clearSession();
      }
    });

  }catch(e){
    console.error(e);
  }
}
