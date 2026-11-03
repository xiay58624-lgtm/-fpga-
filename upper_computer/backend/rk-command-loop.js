"use strict";
const {REFRESH_MS}=require("./rk-vision-command");
class ContinuousRkController {
  constructor({send,now=Date.now,onCommand=()=>{},staleMs=10000}) {
    this.send=send;this.now=now;this.onCommand=onCommand;this.staleMs=staleMs;
    this.desired=null;this.lastTelemetryAt=null;this.lastDispatchAt=null;
    this.generation=0;this.inflight=null;this.command=null;this.dispatchCount=0;
    this.held=false;this.stale=false;this.meta={};
  }
  accept(control,meta={}) {
    this.lastTelemetryAt=this.now();this.meta=meta;this.stale=false;
    this.held=control.enabled && !control.action;
    let next=control.action?control:null;
    // A missed detection is not a new command. Hold the last recognized action.
    if (!next && (!this.desired || this.desired.mode!==control.mode))
      next={...control,action:"stop",commandKey:`${control.mode}|stop`,refreshMs:500};
    if (next && (!this.desired || next.commandKey!==this.desired.commandKey || next.enabled!==this.desired.enabled)) {
      this.desired=next;++this.generation;this.lastDispatchAt=null;
    } else if (next) this.desired=next;
    return this.tick();
  }
  tick() {
    const now=this.now();
    if (!this.desired) return null;
    if (this.lastTelemetryAt!==null && now-this.lastTelemetryAt>this.staleMs && !this.stale) {
      this.stale=true;this.held=false;
      this.desired={...this.desired,enabled:false,action:"stop",commandKey:"stale|stop",refreshMs:500};
      ++this.generation;this.lastDispatchAt=null;
    }
    const generation=this.generation, desired=this.desired;
    if (this.inflight?.generation===generation) return this.inflight.promise;
    if (!desired.enabled && this.command?.ok===true && this.command.generation===generation) return null;
    const interval=this.command?.ok===false?500:(REFRESH_MS[desired.action]||500);
    if(this.lastDispatchAt!==null && now-this.lastDispatchAt<interval)return null;
    this.lastDispatchAt=now;++this.dispatchCount;
    const command={id:`rkvision_${now}_${this.dispatchCount}`,type:"drive_action",action:desired.action,
      state:"sending",ok:null,source:"rk_realtime_vision",created_at_ms:now,error:"",generation,
      refresh_interval_ms:interval,refresh_count:this.dispatchCount};
    const meta=this.meta;
    this.command=command;this.onCommand(command,meta);
    const promise=Promise.resolve().then(()=>this.send(desired.action)).then(result=>({
      ...command,state:"done",ok:true,response:result?.response||"",done_at_ms:this.now()
    }),error=>({...command,state:"failed",ok:false,error:String(error?.code||error?.message||error).slice(0,160),done_at_ms:this.now()}))
      .then(finished=>{
        if(this.generation===generation){this.command=finished;this.onCommand(finished,meta);}
        return finished;
      }).finally(()=>{if(this.inflight?.generation===generation)this.inflight=null;});
    this.inflight={generation,promise};return promise;
  }
  getStatus(){return {action:this.desired?.action||null,mode:this.desired?.mode||"off",held:this.held,stale:this.stale,
    refresh_interval_ms:REFRESH_MS[this.desired?.action]||500,dispatch_count:this.dispatchCount,
    last_dispatch_at_ms:this.lastDispatchAt,last_telemetry_at_ms:this.lastTelemetryAt,command:this.command};}
}
module.exports={ContinuousRkController};
