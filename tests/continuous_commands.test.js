"use strict";
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {resolveRkVisionCommand}=require("../upper_computer/backend/rk-vision-command");
const {ContinuousRkController}=require("../upper_computer/backend/rk-command-loop");
const {WifiCarWsBridge}=require("../upper_computer/backend/wifi-car-ws-bridge");
const resolve=(direction,extra={})=>resolveRkVisionCommand({mode:"adas",inference_enabled:true,inferred_direction:direction,selected_direction:direction,...extra});
const flush=()=>new Promise(r=>setImmediate(r));
async function main(){
  for(const direction of [0,1,2,4,5]){
    for(const condition of [{forbidden:true},{arrow_state:"red"},{alarm:true,alarm_reason:"red_light"}]){
      const x=resolve(direction,condition);assert.equal(x.direction,direction);assert.equal(x.arrowState,"red");assert.equal(x.alarm,true);assert.equal(x.action,"alarm");
    }
    const yellow=resolve(direction,{arrow_state:"yellow",slow:true});assert.equal(yellow.alarm,false);assert.notEqual(yellow.action,"alarm");
    const nav=resolve(direction,{mode:"navigation",arrow_state:"red",forbidden:true});assert.equal(nav.action,"stop");assert.equal(nav.alarm,false);
  }
  assert.equal(resolve(3,{forbidden:true,arrow_state:"red"}).action,"stop","ordinary selected stop raised an alarm");
  assert.equal(resolve(3,{alarm:true,alarm_reason:"red_light"}).action,"alarm");
  assert.equal(resolve(4,{inferred_direction:3,forbidden:true}).direction,4,"old board blocked-left direction lost");
  assert.equal(resolve(5,{inferred_direction:3,forbidden:true}).direction,5,"old board blocked-right direction lost");
  assert.equal(resolve(0,{inference_enabled:false,alarm:true}).action,"stop");
  const socket=new EventEmitter();socket.readyState=1;const raw=[];let delayed="";
  socket.send=(text,callback)=>{const cmd=text.trim();raw.push(cmd);callback?.();if(cmd!==delayed)setImmediate(()=>socket.emit("message",`TCP OK: ${cmd}`));};
  socket.close=()=>{socket.readyState=3;socket.emit("close");};
  const bridge=new WifiCarWsBridge({ackTimeoutMs:1000});bridge.attach(socket);socket.emit("message","WIFICAR READY");
  let now=1000;const loop=new ContinuousRkController({now:()=>now,send:action=>bridge.sendAutoAction(action)});
  await loop.accept(resolve(4));assert.equal(raw.at(-1),"P4");
  now+=10;await loop.accept(resolve(4,{forbidden:true}));assert.equal(raw.at(-1),"H");assert.equal(loop.command.ok,true);
  now+=500;await loop.tick();assert.deepEqual(raw.slice(-2),["H","H"]);
  now+=1;await loop.accept(resolve(-1,{arrow_state:"unknown"}));assert.equal(loop.desired.action,"alarm");
  now+=500;await loop.tick();assert.equal(raw.at(-1),"H");
  now+=1;await loop.accept(resolve(0));assert.deepEqual(raw.slice(-2),["K","P1"]);
  now+=500;await loop.tick();assert.equal(raw.at(-1),"P1");
  delayed="P2";const moving=bridge.sendAutoAction("left");moving.catch(()=>{});await flush();await flush();
  assert.equal(raw.at(-1),"P2");await bridge.sendAutoAction("alarm");assert.equal(raw.at(-1),"H","alarm waited for movement ACK");await moving.catch(()=>{});
  await loop.accept(resolve(0,{alarm:true}));now+=10001;await loop.tick();assert.equal(raw.at(-1),"K");assert.equal(loop.stale,true);
  await loop.accept(resolve(5,{forbidden:true}));assert.equal(raw.at(-1),"H");
  await loop.accept(resolve(5,{mode:"off",inference_enabled:false}));assert.equal(raw.at(-1),"K");
  bridge.close();console.log("PASS: ADAS red direction preserved; H repeats; new green clears alarm; urgent H interrupts pending motion; yellow follows green; navigation unchanged; stop/off/stale K");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
