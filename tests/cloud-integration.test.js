"use strict";
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const fs=require("node:fs");
const path=require("node:path");
const WebSocket=require("../upper_computer/backend/node_modules/ws");
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const port=18903,base=`http://127.0.0.1:${port}`;
const deviceToken="isolated-test-device-token-0123456789";
const visionToken="isolated-test-vision-token-0123456789";
const child=spawn(process.execPath,[path.join(__dirname,"../upper_computer/backend/server.js")],{
  cwd:__dirname,env:{PATH:process.env.PATH,HOME:__dirname,HOST:"127.0.0.1",PORT:String(port),
    MYSQL_ENABLED:"0",AI_ENGINE:"fake",WIFICAR_DEVICE_TOKEN:deviceToken,RK_VISION_TOKEN:visionToken},
  stdio:["ignore","pipe","pipe"]});
let output="",ws;const commands=[];
child.stdout.on("data",x=>{output=(output+x).slice(-6000);});
child.stderr.on("data",x=>{output=(output+x).slice(-6000);});
async function get(url){const r=await fetch(base+url);return r.json();}
let sequence=0;
async function post(direction,extra={}){
  const response=await fetch(base+"/api/rk/realtime/vision",{method:"POST",headers:{"content-type":"application/json","x-rk-vision-token":visionToken},
    body:JSON.stringify({mode:"navigation",inference_enabled:true,frame_sequence:++sequence,inferred_direction:direction,arrow_state:"green",...extra})});
  assert.equal(response.status,200);const body=await response.json();await delay(60);return body;
}
async function main(){
  try{
    let ready=false;for(let i=0;i<60;++i){try{await get("/api/wifi-car/status");ready=true;break;}catch{}await delay(100);}
    assert(ready,"isolated server failed to start");
    assert.equal((await fetch(base+"/api/rk/realtime/vision",{method:"POST",body:"{}"})).status,401);
    ws=new WebSocket(`ws://127.0.0.1:${port}/device/wifi-car`,{headers:{Authorization:`Bearer ${deviceToken}`}});
    ws.on("message",data=>{const cmd=data.toString().trim();commands.push({command:cmd,at:Date.now()});ws.send(`TCP OK: ${cmd}`);});
    await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject);});ws.send("WIFICAR READY");await delay(40);
    await post(0);await delay(1150);
    assert(commands.filter(x=>x.command==="P1").length>=3,"stable forward command was not repeated by timer");
    await post(-1,{arrow_state:"unknown"});let latest=await get("/api/rk/realtime/vision/latest");
    assert.equal(latest.esp32_action,"straight");assert.equal(latest.command_held,true);
    await post(1,{arrow_state:"yellow",slow:true});assert.deepEqual(commands.slice(-2).map(x=>x.command),["K","P2"]);
    const before=commands.filter(x=>x.command==="P2").length;await delay(4900);
    assert(commands.filter(x=>x.command==="P2").length>before,"turn command was not repeated");
    await post(1,{alarm:true,alarm_reason:"red_light",arrow_state:"red"});
    latest=await get("/api/rk/realtime/vision/latest");assert.equal(latest.alarm,false);assert.equal(latest.red_light,true);
    assert.equal(latest.esp32_action,"stop");assert.equal(commands.at(-1).command,"K");
    await delay(600);assert.equal(commands.at(-1).command,"K");
    for(const [direction,raw] of [[2,"P3"],[4,"P4"],[5,"P5"]]){await post(direction,{arrow_state:"yellow",slow:true});assert.equal(commands.at(-1).command,raw);}
    assert(!commands.some(x=>x.command==="H"),"navigation red behavior changed");
    for(const direction of [0,1,2,4,5]){
      const blocked=await post(direction,{mode:"adas",selected_direction:direction,forbidden:true,arrow_state:"red"});
      assert.equal(blocked.alarm,true);assert.equal(blocked.latest.inferred_direction,direction);
      assert.equal(blocked.latest.safety_state,"alarm");assert.equal(commands.at(-1).command,"H");
    }
    const beforeAlarm=commands.filter(x=>x.command==="H").length;await delay(1100);
    assert(commands.filter(x=>x.command==="H").length>=beforeAlarm+2,"red alarm not continuously repeated");
    for(const source of ["automatic","decision"]){
      const r=await fetch(base+"/api/wifi-car/command",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"alarm",behavior:{source}})});
      assert.equal(r.status,200);assert.equal((await r.json()).action,"alarm");assert.equal(commands.at(-1).command,"H");
    }
    await post(4,{mode:"adas",selected_direction:4,arrow_state:"yellow",slow:true});assert.deepEqual(commands.slice(-2).map(x=>x.command),["K","P4"]);
    await post(3,{mode:"adas",selected_direction:3,forbidden:true,arrow_state:"red"});assert.equal(commands.at(-1).command,"K");
    await post(0,{mode:"adas"});assert.equal(commands.at(-1).command,"P1");
    await delay(10300);latest=await get("/api/rk/realtime/vision/latest");
    assert.equal(latest.command_loop.stale,true);assert.equal(latest.esp32_action,"stop");assert.equal(commands.at(-1).command,"K");
    await post(0);assert.equal(commands.at(-1).command,"P1");
    await post(-1,{mode:"off",inference_enabled:false});assert.equal(commands.at(-1).command,"K");
    const count=commands.length;await delay(700);assert.equal(commands.length,count);
    for(const source of ["automatic","decision"]){
      const r=await fetch(base+"/api/wifi-car/command",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({action:"alarm",behavior:{source}})});
      assert.equal(r.status,200);assert.equal((await r.json()).action,"stop");assert.equal(commands.at(-1).command,"K");
    }
    assert(commands.some(x=>x.command==="H"),"ADAS red alarm never sent");
    const report={ok:true,test:"isolated full production server HTTP + WebSocket",commands:commands.map(x=>x.command),alarm_count:commands.filter(x=>x.command==="H").length,
      checks:["authenticated HTTP","stable forward repeated","unknown holds last command","yellow same as green","all six directions","timed turn repeated","navigation red ordinary stop","ADAS red arrow preserves direction and repeats H","yellow after red clears alarm","ordinary selected stop does not alarm","immediate K before changed movement","telemetry watchdog","off stops refresh","older operator automatic alarm normalized to stop"]};
    fs.writeFileSync(path.join(__dirname,"integration_report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }finally{ws?.terminate();child.kill("SIGTERM");await delay(300);if(child.exitCode===null)child.kill("SIGKILL");}
}
main().catch(e=>{console.error(e.stack);console.error(output);process.exitCode=1;});
