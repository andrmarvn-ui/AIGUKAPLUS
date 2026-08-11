export function installAiContextCenterV3(app) {
  app.get("/ai-contexts", (_req, res) => res.type("html").send(pageHtml()));
}

function pageHtml() {
  return String.raw`<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trung tâm ngữ cảnh AIGUKA</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f3f6fb;color:#172033;font:14px Arial,sans-serif}.wrap{max-width:1660px;margin:auto;padding:18px}.header{display:flex;justify-content:space-between;gap:16px;align-items:center;background:#fff;border:1px solid #c9d5e4;border-radius:12px;padding:18px 20px;margin-bottom:12px}.header h1{margin:0 0 5px;font-size:25px}.muted{color:#667085}.header a{color:#1f5fbf}.status{padding:10px 13px;border:1px solid #8db9ea;background:#edf6ff;border-radius:8px;margin-bottom:12px}.status.bad{border-color:#e59a9a;background:#fff0f0;color:#9b1c1c}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px}.stat{background:#fff;border:1px solid #c9d5e4;border-radius:10px;padding:12px}.stat b{display:block;font-size:23px;margin-top:5px;color:#203a5f}.tabs{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px}.tabs button,.btn{border:1px solid #aebfd4;background:#fff;border-radius:7px;padding:9px 12px;cursor:pointer}.tabs button.active,.primary{background:#1f61d1!important;border-color:#1f61d1!important;color:#fff!important}.green{background:#087647!important;border-color:#087647!important;color:#fff!important}.danger{background:#c93632!important;border-color:#c93632!important;color:#fff!important}.view{display:none}.view.active{display:block}.panel{background:#fff;border:1px solid #c9d5e4;border-radius:11px;padding:14px}.editor-layout{display:grid;grid-template-columns:330px 1fr;gap:12px}.context-list{height:690px;overflow:auto}.list-head{display:flex;justify-content:space-between;gap:6px;align-items:center;margin-bottom:10px}.context-item{width:100%;display:block;text-align:left;font:inherit;color:inherit;border:1px solid #cfdae8;border-radius:8px;padding:10px;margin-bottom:8px;cursor:pointer;background:#fbfdff}.context-item.active{border-color:#2f6fd4;background:#edf5ff}.context-item.archived{opacity:.55}.badges{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}.badge{display:inline-block;padding:3px 7px;border-radius:999px;background:#edf1f6;font-size:11px}.badge.TEST{background:#fff0bd;color:#765000}.badge.PRODUCTION{background:#d9f5e3;color:#075a34}.badge.OFF{background:#fee4e2;color:#971b18}.form-grid{display:grid;grid-template-columns:2fr 1fr 1fr 100px;gap:8px}.field label{display:block;font-weight:700;font-size:12px;margin-bottom:5px}.field input,.field select,.field textarea{width:100%;border:1px solid #b8c8dc;border-radius:7px;padding:9px;font:inherit}.toolbar{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin:10px 0}.editor{width:100%;min-height:490px;border:1px solid #aebfd4;border-radius:8px;padding:13px;resize:vertical;font:14px/1.55 Consolas,monospace}.meta{display:flex;justify-content:space-between;color:#667085;font-size:12px;margin-top:5px}.note{padding:10px;border:1px solid #9bd3b1;background:#edf9f1;color:#075a34;border-radius:8px;margin:10px 0}.effective-layout{display:grid;grid-template-columns:330px 1fr;gap:12px}.effective-text{width:100%;min-height:590px;border:1px solid #b8c8dc;border-radius:8px;padding:12px;resize:vertical;font:13px/1.5 Consolas,monospace}.source-card{border:1px solid #cfdae8;border-radius:8px;padding:9px;margin:7px 0}.history-row,.log-row{border-bottom:1px solid #dce4ee;padding:11px 3px}.test-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.test-grid textarea{width:100%;min-height:340px;border:1px solid #b8c8dc;border-radius:8px;padding:12px;font:14px/1.5 Arial,sans-serif}.file-label{display:inline-flex;align-items:center;border:1px solid #aebfd4;border-radius:7px;padding:9px 12px;cursor:pointer;background:#fff}.file-label input{display:none}.warning{padding:11px;border:1px solid #e5c276;background:#fff8df;border-radius:8px;color:#6d4a00}.empty{padding:25px;text-align:center;color:#667085}.spinner{position:fixed;right:15px;bottom:15px;background:#087647;color:#fff;border-radius:999px;padding:9px 13px;display:none}.spinner.show{display:block}@media(max-width:950px){.stats{grid-template-columns:1fr 1fr}.editor-layout,.effective-layout,.test-grid{grid-template-columns:1fr}.context-list{height:auto;max-height:360px}.form-grid{grid-template-columns:1fr 1fr}}@media(max-width:600px){.stats,.form-grid{grid-template-columns:1fr}.wrap{padding:9px}.header{align-items:flex-start;flex-direction:column}}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div><h1>Trung tâm ngữ cảnh AIGUKA</h1><div class="muted">Xem, sửa, thay thế toàn bộ ngữ cảnh và thử phản hồi trước khi áp dụng.</div></div>
    <div><a href="/learning-reviewed">AI Học & Prompt</a> · <a href="/dashboard">Dashboard</a></div>
  </div>
  <div id="status" class="status">Đang tải dữ liệu ngữ cảnh…</div>
  <div class="stats">
    <div class="stat">Ngữ cảnh tổng<b id="master-state">Chưa có</b></div>
    <div class="stat">Lớp đang hoạt động<b id="active-count">0</b></div>
    <div class="stat">Tổng ký tự hiệu lực<b id="effective-count">0</b></div>
    <div class="stat">Phiên bản hiện tại<b id="version-stat">—</b></div>
  </div>
  <div class="tabs">
    <button class="active" data-view="editor-view">Soạn ngữ cảnh</button>
    <button data-view="effective-view">Ngữ cảnh đang hiệu lực</button>
    <button data-view="history-view">Lịch sử phiên bản</button>
    <button data-view="test-view">Test AI</button>
  </div>

  <section id="editor-view" class="view active">
    <div class="editor-layout">
      <aside class="panel context-list">
        <div class="list-head"><b>Thư viện ngữ cảnh</b><button id="new-context" class="btn primary">+ Mới</button></div>
        <button id="open-master" class="btn" style="width:100%;margin-bottom:9px">Mở ngữ cảnh tổng AIGUKA</button>
        <div id="context-list"></div>
      </aside>
      <main class="panel">
        <div class="form-grid">
          <div class="field"><label>Tên ngữ cảnh</label><input id="context-name"></div>
          <div class="field"><label>Áp dụng cho Page</label><select id="context-page"></select></div>
          <div class="field"><label>Trạng thái</label><select id="context-mode"><option value="OFF">OFF — chỉ lưu</option><option value="TEST">TEST — chỉ thử nghiệm</option><option value="PRODUCTION">PRODUCTION</option></select></div>
          <div class="field"><label>Ưu tiên</label><input id="context-priority" type="number" value="100"></div>
        </div>
        <div class="toolbar">
          <button id="paste-all" class="btn">Dán và thay nội dung</button>
          <label class="file-label">Nhập TXT / MD / JSON<input id="import-file" type="file" accept=".txt,.md,.json"></label>
          <button id="copy-content" class="btn">Sao chép nội dung</button>
          <button id="clear-content" class="btn">Xóa vùng soạn</button>
        </div>
        <textarea id="context-content" class="editor" placeholder="Dán toàn bộ ngữ cảnh từ AIcake, ChatGPT, Gemini hoặc tài liệu nội bộ vào đây…"></textarea>
        <div class="meta"><span id="char-count">0 ký tự</span><span id="current-version">Chưa lưu</span></div>
        <div class="field" style="margin-top:9px"><label>Ghi chú thay đổi</label><input id="change-note" placeholder="Ví dụ: nhập toàn bộ ngữ cảnh AIcake để test"></div>
        <div class="note"><b>Nguyên tắc:</b> “Thay toàn bộ ngữ cảnh” sẽ ghi nội dung trong vùng soạn vào ngữ cảnh tổng AIGUKA và tạo phiên bản mới. Không tự bật PRODUCTION.</div>
        <div class="toolbar">
          <button id="save-version" class="btn primary">Lưu phiên bản</button>
          <button id="replace-master" class="btn green">Thay toàn bộ ngữ cảnh AIGUKA</button>
          <button id="duplicate-context" class="btn">Tạo bản sao</button>
          <button id="archive-context" class="btn danger">Lưu trữ</button>
          <button id="reload-data" class="btn">Tải lại</button>
        </div>
      </main>
    </div>
  </section>

  <section id="effective-view" class="view">
    <div class="effective-layout">
      <aside class="panel">
        <h3 style="margin-top:0">Cách ghép ngữ cảnh</h3>
        <div class="field"><label>Page cần xem</label><select id="effective-page"></select></div>
        <div class="field" style="margin-top:9px"><label>Môi trường</label><select id="effective-mode"><option value="TEST">TEST</option><option value="PRODUCTION">PRODUCTION</option></select></div>
        <button id="refresh-effective" class="btn primary" style="margin-top:10px;width:100%">Tạo bản xem hiệu lực</button>
        <div id="effective-sources" style="margin-top:12px"></div>
      </aside>
      <main class="panel"><textarea id="effective-content" class="effective-text" readonly></textarea><div class="toolbar"><button id="copy-effective" class="btn">Sao chép bản hiệu lực</button><span id="effective-meta" class="muted"></span></div></main>
    </div>
  </section>

  <section id="history-view" class="view"><div class="panel"><div class="field"><label>Ngữ cảnh</label><select id="history-context"></select></div><div id="history-list" style="margin-top:10px"></div></div></section>

  <section id="test-view" class="view">
    <div class="panel">
      <div class="form-grid">
        <div class="field"><label>Ngữ cảnh dùng để test</label><select id="test-context"></select></div>
        <div class="field"><label>Page</label><select id="test-page"></select></div>
        <div class="field"><label>Nhà cung cấp AI</label><select id="test-provider"></select></div>
        <div class="field"><label>Model</label><input id="test-model"></div>
      </div>
      <div class="warning" style="margin:10px 0">Test AI chỉ tạo phản hồi xem trước trong trang này, không gửi sang Facebook hoặc Messenger.</div>
      <div class="test-grid"><div><b>Tin nhắn thử</b><textarea id="test-input"></textarea></div><div><b>Phản hồi AI</b><textarea id="test-output" readonly></textarea></div></div>
      <div class="toolbar"><button id="run-test" class="btn green">Chạy Test AI</button><span id="test-meta" class="muted"></span></div>
      <h3>Lịch sử test gần đây</h3><div id="test-logs"></div>
    </div>
  </section>
</div>
<div id="spinner" class="spinner">Đang xử lý…</div>
<script>
(function(){
'use strict';
var D={contexts:[],versions:[],pages:[],providers:[],test_logs:[]};
var currentId=null;
var MASTER_KEY='aiguka_master_context';
var $=function(id){return document.getElementById(id)};
var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
function busy(on,text){$('spinner').classList.toggle('show',!!on);if(text)$('spinner').textContent=text}
function status(text,ok){$('status').textContent=text;$('status').className='status'+(ok===false?' bad':'')}
async function api(url,opt){var r=await fetch(url,opt||{});var text=await r.text();var j;try{j=text?JSON.parse(text):{}}catch(e){j={error:text}}if(!r.ok||j.ok===false)throw new Error(j.error||'Có lỗi xảy ra');return j}
function activeContexts(){return D.contexts.filter(function(x){return x.is_active!==false})}
function master(){return D.contexts.find(function(x){return x.context_key===MASTER_KEY&&x.is_active!==false})||null}
function pageOptions(selected){var html='<option value="">Toàn bộ Page</option>';D.pages.forEach(function(p){html+='<option value="'+esc(p.page_id)+'"'+(String(p.page_id)===String(selected||'')?' selected':'')+'>'+esc(p.page_name)+'</option>'});return html}
function contextOptions(selected){return activeContexts().map(function(x){return '<option value="'+esc(x.id)+'"'+(String(x.id)===String(selected||'')?' selected':'')+'>'+esc(x.context_name)+'</option>'}).join('')}
function modeClass(mode){return ['OFF','TEST','PRODUCTION'].indexOf(mode)>=0?mode:'OFF'}
function bindContextItems(){
    document.querySelectorAll('#context-list [data-context-id]').forEach(function(row){
      row.onclick=function(event){
        event.preventDefault();
        event.stopPropagation();
        selectContext(row.getAttribute('data-context-id'));
      };
    });
  }
  function renderList(){
    var list=$('context-list');
    var rows=activeContexts().slice().sort(function(a,b){return Number(a.priority||100)-Number(b.priority||100)});
    list.innerHTML=rows.map(function(x){
      return '<button type="button" class="context-item '+(String(x.id)===String(currentId)?'active':'')+'" data-context-id="'+esc(x.id)+'"><b>'+esc(x.context_name)+'</b><div class="badges"><span class="badge '+modeClass(x.usage_mode)+'">'+esc(x.usage_mode)+'</span><span class="badge">v'+esc(x.current_version||0)+'</span><span class="badge">'+esc(D.pages.find(function(p){return String(p.page_id)===String(x.page_id)})?.page_name||'Toàn bộ Page')+'</span></div><small>'+Number((x.content||'').length).toLocaleString('vi-VN')+' ký tự</small></button>';
    }).join('')||'<div class="empty">Chưa có ngữ cảnh.</div>';
    bindContextItems();
  }
  function renderSelectors(){var selected=currentId||'';$('context-page').innerHTML=pageOptions($('context-page').value);$('effective-page').innerHTML=pageOptions($('effective-page').value);$('test-page').innerHTML=pageOptions($('test-page').value);$('history-context').innerHTML=contextOptions($('history-context').value||selected);$('test-context').innerHTML=contextOptions($('test-context').value||selected);$('test-provider').innerHTML=D.providers.filter(function(x){return x.is_enabled!==false}).map(function(x){return '<option value="'+esc(x.provider_key)+'">'+esc(x.provider_name)+' · '+esc(x.model_name||'chưa chọn model')+'</option>'}).join('')||'<option value="">Chưa cấu hình AI</option>'}
function renderStats(){var m=master();var active=activeContexts().filter(function(x){return x.usage_mode!=='OFF'});var effective=buildEffective($('effective-page').value,$('effective-mode').value);$('master-state').textContent=m?'v'+(m.current_version||0):'Chưa có';$('active-count').textContent=String(active.length);$('effective-count').textContent=Number(effective.text.length).toLocaleString('vi-VN');var c=D.contexts.find(function(x){return x.id===currentId});$('version-stat').textContent=c?'v'+(c.current_version||0):'—'}
function selectContext(id){
    id=String(id||'');
    var x=D.contexts.find(function(v){return String(v.id)===id});
    if(!x){status('Không tìm thấy ngữ cảnh đã chọn. Hãy bấm Tải lại.',false);return}
    currentId=String(x.id);
    $('context-name').value=x.context_name||'';
    $('context-page').innerHTML=pageOptions(x.page_id||'');
    $('context-mode').value=x.usage_mode||'OFF';
    $('context-priority').value=x.priority||100;
    $('context-content').value=String(x.content||'');
    $('change-note').value='';
    $('current-version').textContent='Phiên bản hiện tại: v'+(x.current_version||0);
    updateCount();
    renderList();
    renderStats();
    $('history-context').value=String(x.id);
    $('test-context').value=String(x.id);
    renderHistory();
    status('Đã mở “'+(x.context_name||'Ngữ cảnh')+'” · '+Number((x.content||'').length).toLocaleString('vi-VN')+' ký tự.');
  }
  function newContext(){currentId=null;$('context-name').value='Ngữ cảnh mới';$('context-page').innerHTML=pageOptions('');$('context-mode').value='OFF';$('context-priority').value=100;$('context-content').value='';$('change-note').value='';$('current-version').textContent='Chưa lưu';updateCount();renderList();renderStats()}
function updateCount(){$('char-count').textContent=Number($('context-content').value.length).toLocaleString('vi-VN')+' ký tự'}
function payload(extra){var old=D.contexts.find(function(x){return x.id===currentId});return Object.assign({id:currentId,context_name:$('context-name').value.trim(),page_id:$('context-page').value||null,source_type:old?.source_type||'manual',content:$('context-content').value,usage_mode:$('context-mode').value,priority:Number($('context-priority').value||100),is_active:true,change_note:$('change-note').value.trim(),metadata:Object.assign({},old?.metadata||{},{last_edited_from:'aiguka_context_center_v3'})},extra||{})}
async function load(preserve){busy(true,'Đang tải…');var keep=preserve||currentId;D=await api('/api/ai-contexts');renderList();renderSelectors();if(keep&&D.contexts.some(function(x){return x.id===keep}))selectContext(keep);else if(master())selectContext(master().id);else if(activeContexts()[0])selectContext(activeContexts()[0].id);else newContext();renderHistory();renderLogs();refreshEffective();status('Đã tải '+D.contexts.length+' ngữ cảnh.');busy(false)}
async function save(data){if(!data.context_name)throw new Error('Cần nhập tên ngữ cảnh');if(data.usage_mode==='PRODUCTION'&&!confirm('Bạn đang chọn PRODUCTION. Tiếp tục lưu?'))return null;busy(true,'Đang lưu…');var j=await api('/api/ai-contexts/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});await load(j.data.id);status('Đã lưu phiên bản mới.');return j.data}
function buildEffective(pageId,mode){var allowed=mode==='PRODUCTION'?['PRODUCTION']:['PRODUCTION','TEST'];var sources=activeContexts().filter(function(x){return allowed.indexOf(x.usage_mode)>=0&&(!x.page_id||String(x.page_id)===String(pageId||''))}).sort(function(a,b){return Number(a.priority||100)-Number(b.priority||100)});var text=sources.map(function(x){return '===== '+x.context_name+' | '+x.usage_mode+' | ưu tiên '+x.priority+' =====\n'+(x.content||'')}).join('\n\n');return {sources:sources,text:text}}
function refreshEffective(){var r=buildEffective($('effective-page').value,$('effective-mode').value);$('effective-content').value=r.text;$('effective-sources').innerHTML=r.sources.map(function(x){return '<div class="source-card"><b>'+esc(x.context_name)+'</b><br><span class="badge '+modeClass(x.usage_mode)+'">'+esc(x.usage_mode)+'</span> · ưu tiên '+esc(x.priority)+' · '+Number((x.content||'').length).toLocaleString('vi-VN')+' ký tự</div>'}).join('')||'<div class="empty">Không có ngữ cảnh nào đang hiệu lực ở chế độ này.</div>';$('effective-meta').textContent=r.sources.length+' lớp · '+r.text.length.toLocaleString('vi-VN')+' ký tự';renderStats()}
function renderHistory(){var id=$('history-context').value||currentId;var rows=D.versions.filter(function(x){return x.context_id===id});$('history-list').innerHTML=rows.map(function(x){return '<div class="history-row"><b>Phiên bản '+esc(x.version_no)+'</b> · '+esc(x.usage_mode)+' · '+esc(new Date(x.created_at).toLocaleString('vi-VN'))+'<br>'+esc(x.change_note||'Không có ghi chú')+'<div class="toolbar"><button class="btn" data-preview-version="'+esc(x.version_no)+'">Xem nội dung</button><button class="btn primary" data-restore-version="'+esc(x.version_no)+'">Khôi phục</button></div></div>'}).join('')||'<div class="empty">Chưa có lịch sử.</div>'}
function renderLogs(){$('test-logs').innerHTML=D.test_logs.slice(0,30).map(function(x){return '<div class="log-row"><b>'+esc(D.contexts.find(function(c){return c.id===x.context_id})?.context_name||'Ngữ cảnh')+'</b> · '+esc(x.model_name||'')+' · '+esc(x.latency_ms||0)+'ms<details><summary>Xem kết quả</summary><pre style="white-space:pre-wrap">KHÁCH: '+esc(x.input_text||'')+'\n\nAI: '+esc(x.output_text||x.error_message||'')+'</pre></details></div>'}).join('')||'<div class="empty">Chưa có lần test.</div>'}
async function copyText(text){try{await navigator.clipboard.writeText(text);status('Đã sao chép vào clipboard.')}catch(e){status('Trình duyệt không cho truy cập clipboard. Hãy chọn nội dung và nhấn Ctrl+C.',false)}}

document.querySelectorAll('[data-view]').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('[data-view]').forEach(function(x){x.classList.toggle('active',x===b)});document.querySelectorAll('.view').forEach(function(v){v.classList.toggle('active',v.id===b.dataset.view)});if(b.dataset.view==='effective-view')refreshEffective();if(b.dataset.view==='history-view')renderHistory()})});
$('context-list').addEventListener('click',function(e){var row=e.target.closest('[data-context-id]');if(row)selectContext(row.getAttribute('data-context-id'))});
$('new-context').addEventListener('click',newContext);
$('open-master').addEventListener('click',function(){var m=master();m?selectContext(m.id):newContext();if(!m){$('context-name').value='AIGUKA — Ngữ cảnh tổng';$('change-note').value='Tạo ngữ cảnh tổng AIGUKA'}});
$('context-content').addEventListener('input',updateCount);
$('save-version').addEventListener('click',function(){save(payload()).catch(function(e){busy(false);status(e.message,false)})});
$('replace-master').addEventListener('click',async function(){try{if(!confirm('Thay toàn bộ ngữ cảnh tổng AIGUKA bằng nội dung đang soạn? Một phiên bản mới sẽ được tạo.'))return;var m=master();var p=payload({id:m?.id||null,context_key:MASTER_KEY,context_name:'AIGUKA — Ngữ cảnh tổng',usage_mode:'OFF',priority:1,source_type:'master',change_note:$('change-note').value.trim()||'Thay toàn bộ ngữ cảnh tổng'});await save(p)}catch(e){busy(false);status(e.message,false)}});
$('duplicate-context').addEventListener('click',function(){var old=D.contexts.find(function(x){return x.id===currentId});if(!old){status('Chưa chọn ngữ cảnh để tạo bản sao.',false);return}currentId=null;$('context-name').value=old.context_name+' — Bản sao';$('context-mode').value='OFF';$('change-note').value='Tạo bản sao';$('current-version').textContent='Bản sao chưa lưu';renderList();renderStats()});
$('archive-context').addEventListener('click',async function(){try{if(!currentId)throw new Error('Chưa chọn ngữ cảnh');if(!confirm('Lưu trữ ngữ cảnh này?'))return;busy(true,'Đang lưu trữ…');await api('/api/ai-contexts/'+encodeURIComponent(currentId),{method:'DELETE'});currentId=null;await load();status('Đã lưu trữ ngữ cảnh.')}catch(e){busy(false);status(e.message,false)}});
$('reload-data').addEventListener('click',function(){load(currentId).catch(function(e){busy(false);status(e.message,false)})});
$('paste-all').addEventListener('click',async function(){try{var text=await navigator.clipboard.readText();if(!text)throw new Error('Clipboard trống');if($('context-content').value&&!confirm('Thay toàn bộ nội dung hiện tại bằng nội dung trong clipboard?'))return;$('context-content').value=text;updateCount();status('Đã dán '+text.length.toLocaleString('vi-VN')+' ký tự.')}catch(e){$('context-content').focus();status('Hãy nhấn Ctrl+V trực tiếp vào vùng soạn. Trình duyệt đang chặn nút đọc clipboard.',false)}});
$('copy-content').addEventListener('click',function(){copyText($('context-content').value)});
$('copy-effective').addEventListener('click',function(){copyText($('effective-content').value)});
$('clear-content').addEventListener('click',function(){if(confirm('Xóa toàn bộ nội dung trong vùng soạn?')){$('context-content').value='';updateCount()}});
$('import-file').addEventListener('change',function(e){var file=e.target.files&&e.target.files[0];if(!file)return;var reader=new FileReader();reader.onload=function(){var text=String(reader.result||'');if(file.name.toLowerCase().endsWith('.json')){try{var j=JSON.parse(text);text=typeof j==='string'?j:(j.content||j.context||j.prompt||JSON.stringify(j,null,2))}catch(_){}}$('context-content').value=text;updateCount();status('Đã nhập '+file.name+' · '+text.length.toLocaleString('vi-VN')+' ký tự.')};reader.onerror=function(){status('Không đọc được tệp.',false)};reader.readAsText(file,'utf-8')});
$('effective-page').addEventListener('change',refreshEffective);$('effective-mode').addEventListener('change',refreshEffective);$('refresh-effective').addEventListener('click',refreshEffective);
$('history-context').addEventListener('change',renderHistory);
$('history-list').addEventListener('click',async function(e){var preview=e.target.closest('[data-preview-version]');var restore=e.target.closest('[data-restore-version]');var id=$('history-context').value;if(preview){var v=D.versions.find(function(x){return x.context_id===id&&String(x.version_no)===String(preview.dataset.previewVersion)});if(v){$('context-content').value=v.content||'';updateCount();document.querySelector('[data-view="editor-view"]').click();status('Đang xem nội dung phiên bản '+v.version_no+'. Chưa ghi đè dữ liệu.')}}if(restore){try{if(!confirm('Khôi phục phiên bản '+restore.dataset.restoreVersion+'?'))return;busy(true,'Đang khôi phục…');await api('/api/ai-contexts/restore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({context_id:id,version_no:Number(restore.dataset.restoreVersion)})});await load(id);status('Đã khôi phục phiên bản.')}catch(err){busy(false);status(err.message,false)}}});
$('test-provider').addEventListener('change',function(){var p=D.providers.find(function(x){return x.provider_key===$('test-provider').value});$('test-model').value=p?.model_name||''});
$('run-test').addEventListener('click',async function(){try{var id=$('test-context').value;var input=$('test-input').value.trim();if(!id)throw new Error('Cần chọn ngữ cảnh đã lưu');if(!input)throw new Error('Cần nhập tin nhắn thử');busy(true,'AI đang trả lời…');var j=await api('/api/ai-contexts/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({context_id:id,page_id:$('test-page').value||null,provider_key:$('test-provider').value||null,model_name:$('test-model').value.trim()||null,input_text:input})});$('test-output').value=j.output_text||'';$('test-meta').textContent=(j.provider_key||'AI')+' · '+(j.model_name||'')+' · '+j.latency_ms+'ms';await load(id);document.querySelector('[data-view="test-view"]').click();status('Test thành công. Không gửi tới khách.')}catch(e){busy(false);status(e.message,false)}});
load().catch(function(e){busy(false);status(e.message,false)});
})();
</script>
<!-- AIGUKA_CONTEXT_CARD_SELECTION_V1 --></body>
</html>`;
}
