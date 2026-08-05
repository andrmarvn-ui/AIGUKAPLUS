import test from "node:test";
import assert from "node:assert/strict";
import { installReportRoutes } from "../report-handler.js";

function makeApp(){
  const routes=new Map();
  return {
    get(path,handler){routes.set(path,handler);},
    route(path){return routes.get(path);}
  };
}

function makeResponse(){
  return {
    statusCode:200,
    headers:new Map(),
    payload:null,
    setHeader(name,value){this.headers.set(String(name).toLowerCase(),String(value));},
    status(code){this.statusCode=code;return this;},
    json(value){this.payload=value;return this;},
    send(value){this.payload=value;return this;}
  };
}

async function withFetch(handler){
  const original=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(url,options={})=>{
    calls.push({url:String(url),options,body:options.body?JSON.parse(options.body):null});
    return new Response(JSON.stringify({ok:true,data:[],count:0}),{status:200,headers:{"content-type":"application/json"}});
  };
  try{return await handler(calls);}finally{globalThis.fetch=original;}
}

function installedHandler(){
  const app=makeApp();
  installReportRoutes(app,{supabaseUrl:"https://example.supabase.co",publishableKey:"test-key"});
  return app.route("/functions/v1/aiguka-v8-report-api");
}

test("live summary route uses the unified compatibility RPC",async()=>{
  await withFetch(async calls=>{
    const res=makeResponse();
    await installedHandler()({query:{action:"summary",from:"2026-08-05",to:"2026-08-05"}},res);
    assert.equal(res.statusCode,200);
    assert.equal(calls.length,1);
    assert.match(calls[0].url,/v8_report_summary_test$/);
    assert.equal(calls[0].body.p_from,"2026-08-05");
    assert.equal(calls[0].body.p_to,"2026-08-05");
    assert.equal("p_limit" in calls[0].body,false);
  });
});

test("ads daily and leads route to their current live RPCs",async()=>{
  await withFetch(async calls=>{
    const handler=installedHandler();
    for(const action of ["ads","daily","leads"]){
      await handler({query:{action,from:"2026-08-05",to:"2026-08-05"}},makeResponse());
    }
    assert.match(calls[0].url,/v8_report_ads_test$/);
    assert.match(calls[1].url,/v8_report_daily_test$/);
    assert.match(calls[2].url,/v8_report_leads_test$/);
    assert.equal(calls[0].body.p_limit,100);
    assert.equal(calls[1].body.p_limit,100);
    assert.equal(calls[2].body.p_limit,1000);
  });
});

test("filters and health expose the current report service",async()=>{
  await withFetch(async calls=>{
    const handler=installedHandler();
    const health=makeResponse();
    await handler({query:{action:"health"}},health);
    assert.equal(health.payload.version,3);
    assert.equal(health.payload.report_source,"v10_live_reporting_unified");

    const filters=makeResponse();
    await handler({query:{action:"filters"}},filters);
    assert.equal(calls.length,1);
    assert.match(calls[0].url,/v8_report_filters_test$/);
  });
});

test("retired V2.1 query parameter cannot switch production back to stale RPCs",async()=>{
  await withFetch(async calls=>{
    const res=makeResponse();
    await installedHandler()({query:{action:"summary",version:"2.1",from:"2026-08-05",to:"2026-08-05"}},res);
    assert.equal(calls.length,1);
    assert.match(calls[0].url,/v8_report_summary_test$/);
    assert.doesNotMatch(calls[0].url,/v8_report_summary_v21$/);
  });
});
