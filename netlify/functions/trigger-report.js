// Simple HTTP endpoint that runs the report when called
// Will be triggered by external cron service at exact time

const WH = "https://ecostyle.bitrix24.eu/rest/4/mc0jnypsq03nu8qu/";
const CHAT_ID = "chat284994";
const SECRET = "ecostyle2026report";

async function bx(m,p={}){const r=await fetch(WH+m,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)});if(!r.ok)throw new Error(m+": HTTP "+r.status);return r.json();}
async function bxAll(m,p={},k=null){let a=[],s=0;while(true){const d=await bx(m,{...p,start:s});let i=d.result;if(k&&i&&i[k])i=i[k];if(Array.isArray(i))a=a.concat(i);if(!d.next)break;s=d.next;}return a;}

function zavdannya(n){
  if(n%100>=11&&n%100<=14)return n+" завдань";
  const l=n%10;
  if(l===1)return n+" завдання";
  if(l>=2&&l<=4)return n+" завдання";
  return n+" завдань";
}
function overdueStr(od,total){
  if(!od)return"";
  const pct=total?Math.round(od/total*100):0;
  const zv=zavdannya(od);
  if(pct>30)return" ([COLOR=#ff0000]⏰ прострочено "+zv+", "+pct+"%[/COLOR])";
  return" (⏰ прострочено "+zv+", "+pct+"%)";
}
function f(v){return v?" "+v+" ":" - ";}

function getReportDate(){
  const now=new Date();
  const kyiv=new Date(now.toLocaleString("en-US",{timeZone:"Europe/Kyiv"}));
  const dow=kyiv.getDay();
  let back=1;
  if(dow===1)back=3;else if(dow===0)back=2;else if(dow===6)back=1;
  const rd=new Date(kyiv);rd.setDate(rd.getDate()-back);
  const y=rd.getFullYear(),mo=String(rd.getMonth()+1).padStart(2,"0"),da=String(rd.getDate()).padStart(2,"0");
  return{ds:y+"-"+mo+"-"+da,dd:da+"."+mo+"."+y,dow};
}

exports.handler = async function(event) {
  // Simple auth check
  const token = event.queryStringParameters && event.queryStringParameters.token;
  if (token !== SECRET) {
    return { statusCode: 403, body: "Forbidden" };
  }

  try {
    const{ds,dd,dow}=getReportDate();
    if(dow===0||dow===6) return{statusCode:200,body:"Weekend skip"};

    const year=new Date().getFullYear();
    const CUTOFF=year+"-01-01T00:00:00";
    const NOW=new Date().toISOString();

    const[users,cre,comp,chg,crm]=await Promise.all([
      bxAll("user.get",{filter:{ACTIVE:true,USER_TYPE:"employee"}}),
      bxAll("tasks.task.list",{filter:{">=CREATED_DATE":ds},select:["id","createdBy"]},"tasks"),
      bxAll("tasks.task.list",{filter:{">=CLOSED_DATE":ds,STATUS:5},select:["id","responsibleId","createdBy","closedBy"]},"tasks"),
      bxAll("tasks.task.list",{filter:{">=CHANGED_DATE":ds},select:["id","responsibleId","createdBy","changedBy"]},"tasks"),
      bxAll("crm.activity.list",{filter:{">=CREATED":ds+"T00:00:00"},select:["ID","RESPONSIBLE_ID","AUTHOR_ID"]})
    ]);

    let imD;try{imD=await bx("im.recent.get");}catch(e){imD={result:[]};}
    const imI=Array.isArray(imD.result)?imD.result:(imD.result&&imD.result.items?imD.result.items:[]);
    const tChat=imI.filter(function(i){return i.message&&i.message.date&&String(i.message.date).indexOf(ds)>=0;});
    const chatU={};
    for(const c of tChat.slice(0,50)){
      const did=c.type==="user"?String(c.id):"chat"+String(c.chat_id||c.id);
      try{const mr=await bx("im.dialog.messages.get",{DIALOG_ID:did,LIMIT:50});
      (mr.result&&mr.result.messages||[]).forEach(function(m){if(m.date&&String(m.date).indexOf(ds)>=0){const a=String(m.author_id||"");if(a&&a!=="0")chatU[a]=(chatU[a]||0)+1;}});}catch(e){}
    }

    const allTasks=await bxAll("tasks.task.list",{filter:{"!STATUS":5},select:["id","responsibleId","createdBy","deadline","status","title"]},"tasks");

    const um={};
    users.forEach(function(u){const id=String(u.ID);um[id]={id:id,nm:(u.LAST_NAME||"")+" "+(u.NAME||""),cr:0,cx:0,ct:0,cm:0,ch:0,wk:0};um[id].nm=um[id].nm.trim();});

    cre.forEach(function(t){const u=String(t.createdBy||"");if(u&&um[u])um[u].cr++;});
    comp.forEach(function(t){const r=String(t.responsibleId||""),c=String(t.createdBy||"");if(r&&um[r])um[r].cx++;if(c&&c!==r&&um[c])um[c].ct++;});
    const uT={};chg.forEach(function(t){const tid=String(t.id||"");[t.responsibleId,t.createdBy,t.changedBy].forEach(function(v){const u=String(v||"");if(u&&um[u]){if(!uT[u])uT[u]={};uT[u][tid]=1;}});});
    for(const uid in uT)if(um[uid])um[uid].wk=Object.keys(uT[uid]).length;
    crm.forEach(function(a){[a.RESPONSIBLE_ID,a.AUTHOR_ID].forEach(function(v){const u=String(v||"");if(u&&um[u])um[u].cm++;});});
    for(const uid in chatU)if(um[uid])um[uid].ch=chatU[uid];

    const active=Object.values(um).filter(function(u){return u.cr+u.cx+u.ct+u.cm+u.ch+u.wk>0;});
    const total=Object.keys(um).length;
    const pct=total?Math.round(active.length/total*100):0;

    // Workload
    const respAll={},respOD={};
    const crTitles={},crTaskList=[];
    allTasks.forEach(function(t){
      const r=String(t.responsibleId||""),c=String(t.createdBy||"");
      const dl=t.deadline||"",st=String(t.status||"");
      if(r&&um[r]&&!(dl&&dl<CUTOFF)){
        respAll[r]=(respAll[r]||0)+1;
        if(dl&&dl<NOW&&dl>=CUTOFF&&(st==="2"||st==="3"))respOD[r]=(respOD[r]||0)+1;
      }
      if(c&&um[c]&&r&&um[r]&&c!==r&&!(dl&&dl<CUTOFF)){
        if(!crTitles[c])crTitles[c]=[];
        crTitles[c].push((t.title||"").substring(0,25));
        crTaskList.push(t);
      }
    });
    const autoT={};
    for(const c in crTitles){const cnt={};crTitles[c].forEach(function(t){cnt[t]=(cnt[t]||0)+1;});autoT[c]=new Set(Object.entries(cnt).filter(function(e){return e[1]>3;}).map(function(e){return e[0];}));}
    const creAll={},creOD={};
    crTaskList.forEach(function(t){
      const c=String(t.createdBy||""),title=(t.title||"").substring(0,25);
      if(autoT[c]&&autoT[c].has(title))return;
      const dl=t.deadline||"",st=String(t.status||"");
      creAll[c]=(creAll[c]||0)+1;
      if(dl&&dl<NOW&&dl>=CUTOFF&&(st==="2"||st==="3"))creOD[c]=(creOD[c]||0)+1;
    });

    const sorted=active.slice().sort(function(a,b){return(b.cr+b.cx+b.ct+b.cm+b.ch+b.wk)-(a.cr+a.cx+a.ct+a.cm+a.ch+a.wk);});

    let lines=[];
    sorted.forEach(function(u,i){
      const b=i===0?"[B]":"",be=i===0?"[/B]":"";
      lines.push((i+1)+". "+b+u.nm+be+":   📝"+f(u.cr)+" ✅"+f(u.cx)+" 🔒"+f(u.ct)+" 💼"+f(u.cm)+" 💬"+f(u.ch)+" 📂"+f(u.wk));
    });

    let lResp=[];
    Object.entries(respAll).sort(function(a,b){return b[1]-a[1];}).forEach(function(e){
      if(e[1]<3)return;
      lResp.push((lResp.length+1)+". "+um[e[0]].nm+" — "+e[1]+overdueStr(respOD[e[0]]||0,e[1]));
    });

    let lCre=[];
    Object.entries(creAll).sort(function(a,b){return b[1]-a[1];}).forEach(function(e){
      if(e[1]<1)return;
      lCre.push((lCre.length+1)+". "+um[e[0]].nm+" — "+e[1]+overdueStr(creOD[e[0]]||0,e[1]));
    });

    const msg="[B]📊 Активність команди в Битрикс24 за "+dd+"[/B]\nАктивних співробітників: "+active.length+" з "+total+" ("+pct+"%)\n\n📝 створено задач\n✅ виконано задач\n🔒 закрито задач\n💼 CRM\n💬 дописів к задачам\n📂 редагування задач\n\n"+lines.join("\n")+"\n\n━━━━━━━━━━━━━━━━━━━━━\n\n[B]📋 Задачі до виконання[/B] (від 3х задач)\n\n"+lResp.join("\n")+"\n\n━━━━━━━━━━━━━━━━━━━━━\n\n[B]📤 Задачі, видані в роботу[/B]\n\n"+lCre.join("\n");

    await bx("im.message.add",{DIALOG_ID:CHAT_ID,MESSAGE:msg,SYSTEM:"Y"});
    return{statusCode:200,body:"Sent report for "+dd};
  } catch(e) {
    return{statusCode:500,body:e.message};
  }
};
