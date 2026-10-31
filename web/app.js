// --- PR-4: one panel, many players. The token decides whose crews you see. ---
var CM_TOKEN_KEY='nfCmToken';
var cmToken=(new URLSearchParams(location.search)).get('token')||'';
try{cmToken=cmToken||localStorage.getItem(CM_TOKEN_KEY)||'';if(cmToken){localStorage.setItem(CM_TOKEN_KEY,cmToken);}}catch(e){}
var __plainFetch=window.fetch.bind(window);
window.fetch=function(input,init){
  init=init||{};
  var url=typeof input==='string'?input:(input&&input.url)||'';
  if(url.indexOf('/api/')===0&&cmToken){
    init.headers=Object.assign({},init.headers||{},{'x-cm-token':cmToken});
  }
  return __plainFetch(input,init).then(function(res){
    if(res.status===401){showLogin(true);}
    return res;
  });
};
function showLogin(show){
  var box=document.getElementById('loginBox');
  if(box){box.style.display=show?'flex':'none';}
}
function submitLogin(){
  var input=document.getElementById('loginToken');
  var value=((input&&input.value)||'').trim();
  if(!value){return;}
  __plainFetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:value})})
    .then(function(r){return r.json().then(function(j){return {ok:r.ok,body:j};});})
    .then(function(x){
      if(!x.ok){logLine('令牌无效');return;}
      cmToken=value;
      try{localStorage.setItem(CM_TOKEN_KEY,value);}catch(e){}
      showLogin(false);
      location.reload();
    }).catch(function(e){logLine('登录失败：'+e);});
}
function presetValue(){var s=document.getElementById('preset');return s.value||'all';}
// 删除当前蓝图：二次确认 → POST /api/config/delete → 重新拉一次状态刷新下拉框。
function deletePreset(){
  var sel=document.getElementById('preset');
  var id=sel&&sel.value?String(sel.value):'';
  if(!id){logLine('没有可删除的蓝图');return;}
  var label=sel.options[sel.selectedIndex]?sel.options[sel.selectedIndex].text:id;
  if(!confirm('确定删除蓝图「'+label+'」？\n\n这会删掉服务端 configs/'+id+'.json，删了要重新导入。')){return;}
  fetch('/api/config/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
    .then(function(r){return r.json();})
    .then(function(j){
      if(!j||j.ok!==true){logLine('删除蓝图失败：'+((j&&j.message)||(j&&j.error)||'未知'));return;}
      logLine(j.message||('已删除蓝图：'+id));
      fetch('/api/status').then(function(r){return r.json();}).then(function(s){render(s);}).catch(function(){});
    }).catch(function(e){logLine('删除蓝图请求失败：'+e);});
}
// ---- P2 辅助：设置抽屉 / 行内 ⋯ 菜单 / 状态中文化 / 特殊装备类型名 ----
var MODE_LABEL={STOP:'待机',ORBIT:'环绕中',FOLLOW:'跟随中',WARP:'跃迁中',ALIGN:'对齐中',APPROACH:'接近中',SEEK:'接近中',GOTO:'移动中',WARPTUNNEL:'跃迁中'};
function modeText(m){var raw=String(m||'');if(!raw||raw==='无实体'||raw==='UNKNOWN'){return '不在场景';}return MODE_LABEL[raw.toUpperCase()]||raw;}
var SPECIAL_KIND_LABEL={bastion:'堡垒',siege:'会战',triage:'后勤',industrialCore:'工业核心',special515:'特殊',smartbomb:'炸弹',doomsday:'末日'};
function specialKindLabel(kind){return SPECIAL_KIND_LABEL[String(kind||'')]||String(kind||'特殊');}
function toggleSettings(){ showTab('settings'); }
// ⋯ 菜单：portal 到 body，fixed 定位，不会被表格/滚动容器裁掉。
function closeOps(){
  var layer=document.getElementById('opsMenuLayer');
  if(layer){layer.remove();}
}
function openOps(btn,name,canRecall){
  closeOps();
  if(!btn){return;}
  var layer=document.createElement('div');
  layer.id='opsMenuLayer';
  layer.className='opsMenuLayer';
  var raw=String(name==null?'':name);
  function item(label,cls,onclick,disabled){
    var b=document.createElement('button');
    if(cls){b.className=cls;}
    b.textContent=label;
    if(disabled){b.disabled=true;}
    b.onclick=function(ev){ev.stopPropagation();closeOps();if(!disabled){onclick();}};
    layer.appendChild(b);
  }
  item('回收矿物','',function(){cmd('deliver '+raw);});
  item('召回','',function(){cmd('recall '+raw);},!canRecall);
  item('解散这名船员','danger',function(){
    if(confirm('确认解散 '+raw+'？')){cmd('disband '+raw+' confirm');}
  });
  document.body.appendChild(layer);
  var rect=btn.getBoundingClientRect();
  var width=layer.offsetWidth||150;
  var height=layer.offsetHeight||120;
  var left=Math.max(8,Math.min(rect.right-width,window.innerWidth-width-8));
  // 下面放不下就向上翻，永远留在视口里。
  var top=(rect.bottom+6+height>window.innerHeight)?(rect.top-6-height):(rect.bottom+6);
  layer.style.left=left+'px';
  layer.style.top=Math.max(8,top)+'px';
  setTimeout(function(){document.addEventListener('click',closeOps,{once:true});},0);
}
window.addEventListener('resize',closeOps);
window.addEventListener('scroll',closeOps,true);
document.addEventListener('keydown',function(ev){if(ev.key==='Escape'){closeOps();}});
function spawnCrew(){
  var sel=document.getElementById('spawnCount');
  var count=sel?Math.max(1,Number(sel.value)||1):1;
  cmd('spawn '+presetValue()+' '+count);
}
function mineToggle(name,stop){cmd('mine '+name+(stop?' off':''));}
function cmd(text){
  fetch('/api/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text})})
   .then(function(r){return r.json();})
   .then(function(j){logLine('> '+text+' · '+(j.reply||j.error||''));})
   .catch(function(e){logLine('请求失败：'+e);});
}
var LOG_MAX=300;
function logLine(text,cls){
  var box=document.getElementById('log');
  if(!box){return;}
  var wasBottom=box.scrollTop+box.clientHeight>=box.scrollHeight-24;
  var d=document.createElement('div');
  if(cls){d.className=cls;}
  var now=new Date();
  var hh=('0'+now.getHours()).slice(-2)+':'+('0'+now.getMinutes()).slice(-2)+':'+('0'+now.getSeconds()).slice(-2);
  d.textContent='['+hh+'] '+text;
  box.appendChild(d);
  if(box.childNodes&&typeof box.childNodes.length==='number'){
    while(box.childNodes.length>LOG_MAX){box.removeChild(box.firstChild);}
  }
  // 用户往上翻看历史时不要强制拉到底部。
  if(wasBottom){box.scrollTop=box.scrollHeight;}
}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
// A JS string literal that survives being placed inside an HTML attribute:
// HTML-escaped JSON, so a name with a quote can never break out of cmd('…').
function jsstr(v){return esc(JSON.stringify(String(v==null?'':v)));}
function pct(used,cap){return cap>0?Math.round(used*100/cap):0;}
// 面板版本：和服务端 /api/status 的 version 比，不一致就说明"后端没重启"。
var CM_UI_VERSION='1.0.0';
function syncVersionWarn(s){
  var box=document.getElementById('versionWarn');
  if(!box){return;}
  var serverVersion=String((s&&s.version)||'');
  if(!serverVersion){
    box.hidden=false;
    box.textContent='服务端没报版本号（多半是旧版）：请重启游戏服务端，类型索引和接口才会更新。';
    return;
  }
  if(serverVersion!==CM_UI_VERSION){
    box.hidden=false;
    box.textContent='服务端 '+serverVersion+' / 面板 '+CM_UI_VERSION+'：接口还是旧版的（模块列表会被截断、新字段缺失）。重启游戏服务端后再刷新这一页。';
    return;
  }
  box.hidden=true;
}
function render(s){
  s=s||{};
  syncVersionWarn(s);
  syncDebugToggle(s);
  syncFreeFire(s);
  syncFocusFire(s);
  syncChase(s);
  syncFullAuthority(s);
  syncEngageRule(s);
  syncSettleMode(s);
  syncWarpOn=!!s.syncWarp;
  var syncBtn=document.getElementById('syncBtn');
  if(syncBtn){
    syncBtn.textContent='跟队跃迁：'+(syncWarpOn?'开':'关');
    syncBtn.className=syncWarpOn?'primary':'';
  }
  // 记住"当前真实状态"，面板日志用它说话（不再写死"需要间距才会动"这种误导后缀）
  lastFollow={
    mode:String(s.followFormation||'idle'),
    gap:(typeof s.followDistance==='number'?s.followDistance:-1),
    spacing:(typeof s.crewSpacingMeters==='number'?s.crewSpacingMeters:100)
  };
  // 0.6.8：状态区直接说明"为什么不动"（静止等命令 / 缺少间距），别让人以为是 bug。
  document.getElementById('range').textContent=
    (typeof s.followReason==='string'&&s.followReason)
      ? s.followReason
      : (typeof s.followDistance==='number'&&s.followDistance>=0
        ? '表面间距 '+s.followDistance+' m'
        : '间距未设置');
  var spacingInput=document.getElementById('crewSpacing');
  if(spacingInput&&typeof s.crewSpacingMeters==='number'&&document.activeElement!==spacingInput){
    spacingInput.value=String(s.crewSpacingMeters);
  }
  // 阵型下拉：idle / follow / ladder / ring 四档，和后端真实状态一一对应（不再把 idle 显示成阶梯）
  var formationSel=document.getElementById('followFormation');
  if(formationSel&&s.followFormation&&document.activeElement!==formationSel){
    var fv=String(s.followFormation);
    formationSel.value=(fv==='ring'||fv==='idle'||fv==='follow')?fv:'ladder';
  }
  // 步长只对阶梯有效：跟随/环形时灰掉（idle 时保留可编辑，方便先配好再切阶梯）
  if(spacingInput){
    spacingInput.disabled=(String(s.followFormation)==='ring'||String(s.followFormation)==='follow');
  }
  document.getElementById('cfg').textContent='配装 '+(s.presets?s.presets.length:0)+' 条';

  var list=s.entries||[];
  var rows=document.getElementById('rows');
  if(!list.length){rows.innerHTML='<div class="muted">没有已召唤的船员</div>';}
  else{
    rows.innerHTML=list.map(function(e){
      var cap=e.capacity||0,used=e.used||0,p=pct(used,cap);
      var modeClass=e.active?'ok':(e.mode==='无实体'?'bad':'warn');
      var name=esc(e.name);
      var rawName=String(e.name==null?'':e.name);
      var mining=Boolean(e.mining);
      // 采矿中就把按钮变成「停止采矿」；其它模块在跑时不允许再点开始。
      var canMine=mining||!e.active;
      var canRecall=e.mode!=='无实体';
      var specialBtn='';
      if(e.siege){
        var siegePending=e.siege.pending===true;
        var siegeWait=Math.ceil((Number(e.siege.cooldownRemainingMs)||0)/1000);
        specialBtn='<button '+(siegePending?'disabled':'')+' onclick="setSpecialOne('+Number(e.characterID)+',\''+esc(e.siege.kind||'siege')+'\','+(e.siege.active?'false':'true')+')" title="'
          +esc(siegePending?('引擎重激活中，还需约 '+siegeWait+' 秒（锁没过期前点了也会被拒）'):(e.siege.moduleName||e.siege.label||''))+'">'
          +(siegePending?('重激活 '+siegeWait+'s'):((e.siege.active?'关':'开')+specialKindLabel(e.siege.kind)))+'</button>';
      }else if(e.smartbomb){
        specialBtn='<button onclick="setSpecialOne('+Number(e.characterID)+',\'smartbomb\','+(e.smartbomb.active?'false':'true')+')" title="'
          +esc(e.smartbomb.moduleName||'立体炸弹')+'">'+(e.smartbomb.active?'关':'开')+'炸弹</button>';
      }
      return '<div class="crewCard" style="cursor:pointer" onclick="selectCrew(' + Number(e.characterID) + ')">'
        +'<div class="cardHead"><b>'+name+'</b>'
          +((e.warnings&&e.warnings.length)?(' <span class="warnBadge" title="'+esc(e.warnings.join(' · '))+'">'+esc(e.warnings[0])+'</span>'):'')
          +' <span class="modeBadge '+(e.npcMode?'npc':'player')+'">'+(e.npcMode?'NPC':'玩家')+'</span>'
          +'</div>'
        +'<div class="cardLine muted">'+esc(e.hullName||'Covetor')+'</div>'
        +'<div class="cardLine"><span class="'+modeClass+' modeCol" title="'+esc(String(e.mode||''))+'">'+esc(modeText(e.mode))+'</span>'
          +' · 货舱 '+p+'% ('+used+' m³)'+etaText(e)
          +' · 压缩 '+(e.compress?'<span class="ok">可用</span>':'<span class="bad">不可用</span>')
          +'</div>'
        +'<div class="cardOps">'
          +'<button '+(canMine?'':'disabled')+' onclick="event.stopPropagation();mineToggle('+jsstr(rawName)+','+(mining?'true':'false')+')">'+(mining?'停止采矿':'开始采矿')+'</button>'
          +specialBtn
          +'<button onclick="event.stopPropagation();openOps(this,'+jsstr(rawName)+','+(canRecall?'true':'false')+')" title="更多操作（回收/召回/解散）">⋯</button>'
        +'</div></div>';
    }).join('');
  }

  // 顶栏「全部→X」按装配动态生成：只有真的有人装了那种模块才出现。
  var kindBox=document.getElementById('specialKindBtns');
  if(kindBox){
    var kinds=(s.siege&&Array.isArray(s.siege.kinds))?s.siege.kinds:[];
    kindBox.innerHTML=['bastion','siege','triage','industrialCore','special515','smartbomb']
      .filter(function(k){return kinds.indexOf(k)>=0;})
      .map(function(k){return '<button onclick="setSpecialAll(\''+k+'\',true)">全部→'+specialKindLabel(k)+'</button>';})
      .join('');
  }
  drawMiniMap(list);
  var sel=document.getElementById('preset');var cur=sel.value;
  var presets=s.presets||[];
  if(sel.options.length!==presets.length){
    sel.innerHTML=presets.map(function(p){
      var id=(typeof p==='string')?p:(p.id||'');
      var label=(typeof p==='string')?p:(p.name||p.id||'');
      return '<option value="'+esc(id)+'">'+esc(label)+'</option>';
    }).join('');
    if(cur){sel.value=cur;}
  }
}
function toggleFittings(){
  var body=document.getElementById('fitBody');
  if(!body)return;
  var open=body.style.display!=='none';
  body.style.display=open?'none':'block';
}
var allFittings=[];
try{var _q=localStorage.getItem('nfFitQ');if(_q){document.getElementById('fitSearch').value=_q;}}catch(e){}
var fitPage=0;
var FIT_PER_PAGE=20;
function slugify(name,index){
  var s=String(name||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  return s||('plan-'+index);
}
function filteredFittings(){
  var q=(document.getElementById('fitSearch').value||'').trim().toLowerCase();
  if(!q)return allFittings;
  return allFittings.filter(function(f){
    return ((f.name||'')+' '+(f.shipType||'')+' '+(f.file||'')).toLowerCase().indexOf(q)>=0;
  });
}
function renderFittings(){
  var list=filteredFittings();
  var pages=Math.max(1,Math.ceil(list.length/FIT_PER_PAGE));
  if(fitPage>=pages)fitPage=pages-1;
  if(fitPage<0)fitPage=0;
  var rows=document.getElementById('fittingList');
  var slice=list.slice(fitPage*FIT_PER_PAGE,(fitPage+1)*FIT_PER_PAGE);
  document.getElementById('fitPageInfo').textContent=(fitPage+1)+' / '+pages+' 页 · 共 '+list.length+' 条';
  if(!slice.length){rows.innerHTML='<tr><td colspan="4" class="muted">没有匹配的方案</td></tr>';return;}
  rows.innerHTML=slice.map(function(f,i){
    var abs=fitPage*FIT_PER_PAGE+i;
    var id=slugify(f.name,abs);
    return '<tr><td>'+esc(f.name)+'</td><td>'+esc(f.shipType||'-')+'</td><td class="muted">'+esc(f.file)+'</td>'
      +'<td class="ops"><input id="id'+abs+'" value="'+esc(id)+'" style="width:150px;background:#232a34;color:#dbe3ee;border:1px solid #333d4b;border-radius:6px;padding:5px 9px">'
+'<button onclick="doImport('+f.id+','+abs+')">导入为蓝图</button></td></tr>';
  }).join('');
}
function loadFittings(){
  fetch('/api/fittings').then(function(r){return r.json();}).then(function(j){
    allFittings=(j&&j.fittings)||[];
    document.getElementById('fitCount').textContent='共 '+allFittings.length+' 条 · 已导入蓝图 '+(((j&&j.blueprints)||[]).length)+' 个';
    fitPage=0;
    renderFittings();
  }).catch(function(e){logLine('读取方案失败：'+e);});
}
function doImport(fittingID,index){
  var el=document.getElementById('id'+index);
  var id=el?el.value:('fit-'+fittingID);
  fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fittingID:fittingID,id:id,count:1})})
   .then(function(r){return r.json();})
   .then(function(j){logLine('导入装配 '+fittingID+' → '+id+' · '+(j.reply||j.error||''));loadFittings();})
   .catch(function(e){logLine('导入失败：'+e);});
}
loadFittings();
pollCrewLog();
setInterval(pollCrewLog, 2000);
initSplitter();
function setConn(ok){
  var b=document.getElementById('conn');
  if(!b)return;
  b.textContent=ok?'已连接':'重连中…';
  b.className='badge '+(ok?'on':'off');
}
function syncButtons(hasCrew){
  ['mineAll','deliverAll','recallAll','disbandAll','fleetJoinAll'].forEach(function(id){
    var el=document.getElementById(id);
    if(el){el.disabled=!hasCrew;}
  });
}
var selectedCrew=0;
var detailTimer=null;
function healthBar(label,item,unit){
  if(!item){return '<div class="muted">'+label+'：未知</div>';}
  var pct=item.max>0?Math.round(item.cur*100/item.max):0;
  var color=pct>60?'#47c1a8':(pct>30?'#e2b93b':'#e06c75');
  return '<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;font-size:13px">'
    +'<span>'+label+'</span><span>'+item.cur+' / '+item.max+' '+unit+'（'+pct+'%）</span></div>'
    +'<div class="track"><div class="fill" style="width:'+Math.min(100,pct)+'%;background:'+color+'"></div></div></div>';
}
function selectCrew(id){
  selectedCrew=(selectedCrew===id)?0:id;
  if(detailTimer){clearInterval(detailTimer);detailTimer=null;}
  if(!selectedCrew){renderDetail(null);return;}
  fetchDetail();
  detailTimer=setInterval(fetchDetail,2000);
}
function fetchDetail(){
  if(!selectedCrew){return;}
  fetch('/api/crew?characterID='+selectedCrew).then(function(r){return r.json();})
    .then(function(j){renderDetail(j);}).catch(function(){renderDetail(null);});
}
function renderSpecial(payload){
  // 详情响应把船员信息放在 payload.crew 下；直接传某个船员对象也要能用。
  var c=(payload&&payload.crew)?payload.crew:(payload||{});
  var list=c.special||[];
  if(!list.length&&!c.siege){return '';}
  if(!list.length&&c.siege){
    // 旧服务端的 payload（只有 siege 字段）也能显示。
    list=[{id:c.siege.kind||'siege',name:c.siege.moduleName||c.siege.label,moduleName:c.siege.moduleName,
      on:c.siege.active===true,wanted:c.siege.wanted===true,penalty:[],hasEntity:c.siege.hasEntity!==false}];
  }
  var html='<div style="margin-top:6px;padding:6px;border:1px solid #3a2f4a;border-radius:6px;background:#1e1a26">';
  html+='<div class="muted" style="margin-bottom:4px">特殊装备（玩家开关，船员不会自己开）</div>';
  list.forEach(function(item){
    var id=String(item.id||'');
    var label=item.name||id;
    var cid=Number(c.characterID||0);
    html+='<div style="display:flex;gap:8px;align-items:center;margin-top:4px;flex-wrap:wrap">';
    html+='<span>'+esc(label)+'</span>';
    if(id==='doomsday'){
      // PLAN §18.11：末日是一次性武器，显示伤害/半径/冷却 + 发射按钮。
      var cd=Math.max(0,Number(item.cooldownRemainingMs||item.readyInMs)||0);
      var dmg=item.damage||{};
      var dmgText=['em','thermal','kinetic','explosive'].map(function(k){return (Number(dmg[k])||0);}).some(function(v){return v>0;})
        ? '伤害 EM'+Math.round(Number(dmg.em)||0)+' 热'+Math.round(Number(dmg.thermal)||0)+' 动'+Math.round(Number(dmg.kinetic)||0)+' 爆'+Math.round(Number(dmg.explosive)||0)
        : '伤害未知';
      html+='<span class="muted">'+esc(dmgText)+' · '+Math.round((Number(item.radiusMeters)||0)/1000)+'km</span>';
      if(cd>0){
        html+='<span class="bad">冷却 '+Math.ceil(cd/1000)+'s</span>';
      }else{
        html+='<button class="danger" style="padding:2px 10px;font-size:12px" onclick="if(confirm(\'发射末日不可撤销，确定？\'))fireDoomsday('+cid+')">发射末日</button>';
      }
    }else{
      // PLAN §18.3：会战/堡垒 —— 当前状态 + 启动/关闭 + 启动后的惩罚清单。
      var on=item.on===true;
      // 引擎的重激活锁还没到期：显示真实倒计时，并且不允许点（点了引擎也会拒）。
      var pending=item.pending===true;
      var waitS=Math.ceil((Number(item.cooldownRemainingMs)||0)/1000);
      var penalty=(item.penalty||[]).join(' · ');
      html+='<span class="muted">'+esc(item.moduleName||'')+'</span>';
      html+='<span class="'+(on?'ok':'muted')+'">当前：'+(on?'开':'关')+'</span>';
      if(pending){
        html+='<span class="bad">重激活中 '+waitS+'s</span>';
      }
      // 方案 A：告诉玩家这颗模块烧什么（会战/后勤=锶包合物，工业核心=重水，堡垒/炸弹=不要）。
      if(item.fuel&&Number(item.fuel.quantity)>0){
        // 引擎每轮扣一次燃料，所以显示"每轮多少 + 还剩几轮"，不只是单次量。
        var cycleTxt=(Number(item.fuel.cyclesMax)>0)
          ? (' · '+Number(item.fuel.cyclesLeft||0)+'/'+Number(item.fuel.cyclesMax)+' 轮')
          : '';
        html+='<span class="fuelTag">燃料 '+Number(item.fuel.quantity)+'/轮'+cycleTxt+(item.fuel.name?'（'+esc(item.fuel.name)+'）':'')+'</span>';
      }else if(id!=='smartbomb'){
        html+='<span class="fuelTag">无需燃料</span>';
      }
      if(penalty){html+='<span class="muted">启动后：'+esc(penalty)+'</span>';}
      if(item.hasEntity===false){html+='<span class="muted">（船不在场景里）</span>';}
      if(on){
        html+='<button style="padding:2px 10px;font-size:12px" onclick="setSpecialOne('+cid+',\''+esc(id)+'\',false)">关闭</button>';
      }else if(pending){
        html+='<button disabled style="padding:2px 10px;font-size:12px" title="引擎重激活锁还没到期">重激活中 '+waitS+'s</button>';
      }else{
        var ask=(id==='smartbomb')
          ? '立体炸弹会伤到范围内的所有船（含友军/中立），确定允许开火？'
          : '启动后会定身、无法跟随/跃迁，确定启动？';
        html+='<button style="padding:2px 10px;font-size:12px" onclick="if(confirm(\''+ask+'\'))setSpecialOne('+cid+',\''+esc(id)+'\',true)">启动</button>';
      }
    }
    html+='</div>';
  });
  html+='</div>';
  return html;
}
function fireDoomsday(characterID){
  if(!characterID){return;}
  fetch('/api/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({field:'doomsday',characterID:Number(characterID)})})
    .then(function(r){return r.json();})
    .then(function(j){
      logLine(j&&j.message?j.message:('末日：'+((j&&j.error)||'已发射')));
      fetchDetail();
    }).catch(function(e){logLine('末日请求失败：'+e);});
}
// PLAN §18.4：特殊装备开关（堡垒 / 会战 / 末日），走 POST /api/special。
function setSpecialOne(characterID,module,on){
  if(!characterID){return;}
  fetch('/api/special',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({characterID:Number(characterID),module:String(module||''),on:on===true})})
    .then(function(r){return r.json();})
    .then(function(j){
      logLine(j&&j.message?j.message:('特殊装备：'+((j&&j.error)||(on?'已启动':'已关闭'))));
      fetchDetail();
    }).catch(function(e){logLine('特殊装备请求失败：'+e);});
}
function setSpecialAll(module,on){
  fetch('/api/special',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({module:String(module||'all'),on:on===true})})
    .then(function(r){return r.json();})
    .then(function(j){
      logLine(j&&j.message?j.message:('特殊装备全体：'+((j&&j.error)||(on?'已启动':'已关闭'))));
    }).catch(function(e){logLine('特殊装备请求失败：'+e);});
}
// 旧名字保留：顶部按钮以前调 setSiegeAll，外部书签/脚本可能还在用。
function setSiegeAll(on){setSpecialAll('all',on);}
function quickButtons(c){
  var name=esc(c.name||'');
  var rawName=String(c.name||'');
  var isMining=c.mining===true;
  // 已经在采矿就别再给「开始采矿」；反之亦然的道理一样。
  var mining=isMining
    ? ['<button onclick="cmd(\'mine \'+'+jsstr(rawName)+'+\' off\')">停止采矿</button>']
    : ['<button onclick="cmd(\'mine \'+'+jsstr(rawName)+')">开始采矿</button>'];
  mining.push('<button onclick="cmd(\'deliver \'+'+jsstr(rawName)+')">回收矿物</button>');
  var fighting=['<button onclick="cmd(\'stop \'+'+jsstr(rawName)+')">停火</button>',
    '<button onclick="cmd(\'attack all\')">开始攻击</button>'];
  // 停船是独立动作（0.6.8）：单船菜单里也放一个，和"停火"分开。
  var shared=['<button onclick="cmd(\'recall \'+'+jsstr(rawName)+')">召回</button>',
    '<button onclick="cmd(\'halt \'+'+jsstr(rawName)+')">停船</button>'];
  var list=(uiMode==='fight')?fighting.concat(shared):mining.concat(shared);
  return '<div class="quickRow">'+list.join('')+'</div>';
}
function renderDetail(j){
  var pane=document.getElementById('detailPane');
  if(!pane){return;}
  if(!j||!j.ok){pane.innerHTML='<div class="card"><div class="muted">'+(j&&j.problems?esc(j.problems.join(' · ')):'读取失败')+'</div></div>';return;}
  var c=j.crew||{};
  var h=j.health||{};
  var capPct=j.cargoCapacity>0?Math.round(j.cargoUsed*100/j.cargoCapacity):0;
  // One card per module: green = online (enabled), grey = offline, red border = in use.
  var groups={};
  (j.fitting||[]).forEach(function(m){
    var g=m.group||'其它';
    (groups[g]=groups[g]||[]).push(m);
  });
  var order=['高槽','中槽','低槽','改装','子系统','服务'];
  var fitHtml=order.filter(function(g){return groups[g];}).map(function(g){
    var items=groups[g].map(function(m){
      var name=m.name||('#'+m.typeID);
      // A1：常开装备（抗性增强器）不是真在跑的模块，单独一档"常开 · 已生效"，
      // 不能显示成"使用中"，否则和"模块运行"计数自相矛盾。
      // 结算化（S2）：回充器/修甲不再激活模块，用"结算中"标出来，和"使用中"区分。
      var state=m.passive?'常开 · 已生效':(m.active?'使用中':(m.settling?'结算中':''));
      var cls='eq '+(m.online?'eq-on':'eq-off')+(m.passive?' eq-passive':'')+(m.active?' eq-active':'')
        +(m.settling?' eq-active':'');
      var title=name+' · '+(m.online?'已启用':'未启用')+' · '+(m.kind||'装备')
        +(state?' · '+state:'')+((m.passive||m.settling)&&m.effectLabel?' · '+m.effectLabel:'');
      return '<span class="'+cls+'" title="'+esc(title)+'">'+esc(name)
        +'<span class="eqTag">'+esc(m.kind||'')+(state?' · '+state:'')+'</span></span>';
    }).join('');
    return '<div class="slotBlock"><div class="slotHead">'+esc(g)+'</div><div class="eqWrap">'+items+'</div></div>';
  }).join('');
  var cargo=(j.cargo||[]).map(function(it){
    var cls='eq '+(it.isCharge?'eq-on':'eq-off');
    return '<span class="'+cls+'" title="'+esc(it.name||('#'+it.typeID))+' ×'+it.quantity+'">'
      +esc(it.name||('#'+it.typeID))+'<span class="eqTag">×'+it.quantity+' · '+it.volume+' m³</span></span>';
  }).join('');
  pane.innerHTML='<div class="card">'
    +'<div style="display:flex;justify-content:space-between;align-items:center">'
    +'<b>'+esc(c.name||'')+'</b>'
    +'<button onclick="toggleCrewNpc()" style="padding:2px 8px;font-size:12px;margin-right:4px">切换 NPC 模式</button>'
    +'<button onclick="selectCrew('+(c.characterID||0)+')" style="padding:2px 8px;font-size:12px">关闭详情</button></div>'
    +'<div class="muted" style="margin-bottom:4px">'+esc(c.hullName||'')+' · '+esc(c.mode||'')
    +(c.npcMode?' · <span class="modeBadge npc">NPC 模式</span>':' · <span class="modeBadge player">玩家模式</span>')
    +(c.active?' · <span class="ok">模块运行中</span>':'')+'</div>'
    + healthBar('护盾',h.shield,'HP') + healthBar('装甲',h.armor,'HP')
    + healthBar('结构',h.structure,'HP') + healthBar('电容',h.capacitor,'GJ')
    +'<div class="muted" style="margin-top:2px">速度 '+((j.speed&&j.speed.cur)||0)+' / '+((j.speed&&j.speed.max)||0)+' m/s'
    +((j.speed&&j.speed.signatureRadius)?(' · 信号半径 '+j.speed.signatureRadius+' m'):'')+'</div>'
    +((j.crew&&j.crew.remote)?('<div class="muted" style="margin-top:2px">遥修：'
      +(j.crew.remote.families||[]).map(function(f){return esc(f.label);}).join(' / ')
      +(j.crew.remote.active?(' · 正在修 #'+Number(j.crew.remote.targetShipID||0)):' · 待机（血量/电容都够）')+'</div>'):'')
    +'<div class="muted" style="margin-top:2px">运行 '+((j.modulesRunning||0))
    +(Number(j.modulesPassive||0)>0?(' · 常开 '+Number(j.modulesPassive||0)):'')
    +' / 共 '+((j.modulesTotal||0))
    +renderSpecial(j)
    +(j.target?' · '+(j.target.kind==='attack'?'攻击':'采矿')+': '+esc(j.target.name||j.target.id)+(j.target.distance!=null?'（'+Math.round(j.target.distance/1000)+' km）':''):'')
    +'</div>'
    +((j.warnings&&j.warnings.length)?('<div class="warnRow">'+j.warnings.map(function(w){return '<span class="warnBadge">'+esc(w)+'</span>';}).join('')+'</div>'):'')
    +quickButtons(c)
    +'<div style="margin-top:8px"><b>装配</b> <span class="muted">'+((j.fitting||[]).length)+' 件</span></div>'
    +'<div class="fitGrid">'+(fitHtml||'<span class="muted">无装配数据</span>')+'</div>'
    +'<div style="margin-top:8px"><b>货舱</b> <span class="muted">'+j.cargoUsed+' / '+j.cargoCapacity+' m³（'+capPct+'%）</span></div>'
    +'<div class="eqWrap">'+(cargo||'<span class="muted">货舱为空</span>')+'</div>'
    +(j.problems&&j.problems.length?'<div class="muted" style="margin-top:6px">问题：'+esc(j.problems.join(' · '))+'</div>':'')
    +'</div>';
}
var uiMode='mine';
var UI_MODES=['mine','fight','special'];
function setUiMode(mode){
  uiMode=UI_MODES.indexOf(mode)>=0?mode:'mine';
  try{localStorage.setItem('nfUiMode',uiMode);}catch(e){}
  applyUiMode();
  if(typeof currentCrewID!=='undefined'&&currentCrewID){fetchDetail(currentCrewID);}
}
function applyUiMode(){
  // PLAN §18.3：顶部三个模式页签（采矿 / 战斗 / 特殊装备），每个页签带自己的按钮栏。
  var bars={mine:document.getElementById('mineBar'),fight:document.getElementById('fightBar'),special:document.getElementById('specialBar')};
  var tabs={mine:document.getElementById('modeMine'),fight:document.getElementById('modeFight'),special:document.getElementById('modeSpecial')};
  UI_MODES.forEach(function(name){
    if(bars[name]){bars[name].style.display=(uiMode===name)?'':'none';}
    if(tabs[name]){tabs[name].classList.toggle('modeOn',uiMode===name);}
  });
}
(function(){
  try{
    var saved=localStorage.getItem('nfUiMode');
    uiMode=UI_MODES.indexOf(saved)>=0?saved:'mine';
  }catch(e){}
  applyUiMode();
})();
var cargoSamples={};
var freeFireOn=false;
// 火力集中（0.6.13）：运行时开关，按钮状态只认服务端 status.focusFire。
var focusFireOn=false;
var fullAuthorityOn=false;
// 追击（默认关，服务端 status.chaseOutOfRange 为准）。
var chaseOn=false;
function etaText(e){
  var id=Number(e.characterID)||0;
  var cap=Number(e.capacity)||0;
  var used=Number(e.used)||0;
  if(!id||cap<=0){return '';}
  var now=Date.now();
  var prev=cargoSamples[id];
  cargoSamples[id]={used:used,at:now};
  if(!prev||now-prev.at<1500||used<=prev.used){return '';}
  var rate=(used-prev.used)/((now-prev.at)/60000);
  if(rate<=0){return '';}
  var left=(cap-used)/rate;
  if(!isFinite(left)||left<=0||left>600){return '';}
  return ' · 约 '+Math.round(left)+' 分钟满';
}
var syncWarpOn=false;
// 「跟队跃迁」开关：走命令，服务端是 runtime 级状态（不再只读 configs[0]）。
function toggleSyncWarp(){
  var on=!syncWarpOn;
  cmd('syncwarp '+(on?'on':'off'));
  syncWarpOn=on;
  var btn=document.getElementById('syncBtn');
  if(btn){btn.textContent='跟队跃迁：'+(on?'开':'关');btn.className=on?'primary':'';}
  logLine('跟队跃迁 '+(on?'开启':'关闭'));
}
function toggleFreeFire(){
  var on=!freeFireOn;
  cmd(on?'attack all':'attack off');
  logLine('自由开火 '+(on?'开启':'关闭'));
  // 先按点击意图更新，下一次 status 回来再以服务端为准。
  syncFreeFire({freeFire:on});
}
// 按钮状态只认服务端 status.freeFire：刷新页面/换客户端也能对上。
function syncFreeFire(s){
  var btn=document.getElementById('freeFireAll');
  if(!btn){return;}
  var on=Boolean(s&&s.freeFire);
  freeFireOn=on;
  if(on){
    btn.textContent='正在自由开火';
    btn.classList.add('danger');
    btn.title='自由开火已开启：船员会自动锁定附近敌对并开火（再点一次停火）';
  }else{
    btn.textContent='自由开火';
    btn.classList.remove('danger');
    btn.title='开启自由开火：船员自动锁定附近敌对并开火';
  }
}
// 火力集中：解除每拍 3 艘的齐射轮转（走命令，服务端是 runtime 级状态）。
function toggleFocusFire(){
  var on=!focusFireOn;
  cmd('focus '+(on?'on':'off'));
  logLine('火力集中 '+(on?'开启（本拍结算全部船，可能卡顿）':'关闭（恢复 3 艘/拍轮转）'));
  // 先按点击意图更新，下一次 status 回来再以服务端为准。
  syncFocusFire({focusFire:on});
}
function syncFocusFire(s){
  var btn=document.getElementById('focusFireBtn');
  if(!btn){return;}
  var on=Boolean(s&&s.focusFire);
  focusFireOn=on;
  if(on){
    btn.textContent='火力集中：开';
    btn.classList.add('danger');
    btn.title='火力集中已开启：本拍所有冷却好的船一起结算（安全阀 focusFireMaxTickMs 兜底）。再点一次恢复轮转';
  }else{
    btn.textContent='火力集中：关';
    btn.classList.remove('danger');
    btn.title='开启火力集中：本拍所有冷却好的船一起结算（解除每拍 3 艘轮转）。人越多越卡';
  }
}
// 全权开火：自由开火 + 末日武器自动发射。按钮状态以服务端 status 为准，
// 因为开关是运行时状态，刷新页面/换客户端后必须能对上。
function syncEngageRule(s){
  var sel=document.getElementById('engageRule');
  if(!sel||!s){return;}
  var rule=String(s.engagementRule||'npc');
  if(sel.value!==rule){sel.value=rule;}
  sel.title = rule==='npc' ? '只打原生 NPC（绝不会误伤玩家）'
    : rule==='war' ? 'NPC + 与我们宣战的角色'
    : 'NPC + 宣战目标 + 打了我们的人（启发式判定）';
}
function setEngageRule(rule){
  var names={npc:'只打 NPC',defend:'挨打就还手',war:'只打宣战'};
  cmd('attack '+rule);
  logLine('交战规则：'+(names[rule]||rule));
  syncEngageRule({engagementRule:rule});
}
// 追击：射程外时主动靠近；关掉就只在原地等目标进射程。
function toggleChase(){
  var on=!chaseOn;
  fetch('/api/chase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({on:on})})
    .then(function(r){return r.json();})
    .then(function(j){
      if(!j||j.ok!==true){logLine('切换追击失败：'+((j&&j.error)||'未知'));return;}
      syncChase({chaseOutOfRange:on});
      logLine('追击 '+(on?'开启（打不到会靠近）':'关闭'));
    }).catch(function(e){logLine('切换追击请求失败：'+e);});
}
function returnOrbit(){
  fetch('/api/chase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'return'})})
    .then(function(r){return r.json();})
    .then(function(j){
      if(!j||j.ok!==true){logLine('分层环绕失败：'+((j&&j.error)||'未知'));return;}
      logLine('已下令分层环绕（'+(j.cleared||0)+' 名船员结束追击）');
    }).catch(function(e){logLine('分层环绕请求失败：'+e);});
}
var followCloseOn=false;
var followDistTouchedAt=0;
// 最近一次状态里的编队参数：面板日志要按"真实状态"说话，不能写死后缀。
var lastFollow={mode:'idle',gap:-1,spacing:100};
function followSummary(){
  if(lastFollow.mode==='idle'){
    return '（静止：不下发移动指令）';
  }
  if(lastFollow.gap<0){
    return '（还没设间距 → 不会移动）';
  }
  if(lastFollow.mode==='ring'){
    return '（圈半径 '+lastFollow.gap+' m，'+lastFollow.spacing+' 步长不参与环形）';
  }
  if(lastFollow.mode==='follow'){
    return '（全部保持 '+lastFollow.gap+' m，'+lastFollow.spacing+' 步长不参与跟随）';
  }
  return '（间距 '+lastFollow.gap+' m，每艘递增 '+lastFollow.spacing+' m → 第 n 艘 '+lastFollow.gap+'+'+(lastFollow.spacing)+'×(n-1)）';
}
// 改下拉 / 点「跟随」都走这里：按选中的间距下令（0 = 贴住；-1 = 清空、不移动）。
// 注意：这里**不再** `cmd('recall all')` —— 0.6.8 起阵型/间距由 rearm 在下一拍自动生效，
// 而 recall 在间距为空时会退回蓝图的 followRangeMeters（1000 m），会把"静止"的船开出去。
function orderFollow(){
  var sel=document.getElementById('followDist');
  var meters=sel?Number(sel.value):100;
  if(!Number.isFinite(meters)){meters=100;}
  followDistTouchedAt=Date.now();
  if(meters<0){
    followLayeredOrder();
    return;
  }
  setFollowDistance(meters);
}
// 保持选中间距的跟随（引擎 FOLLOW 闭环：间距 + 两船半径）。
function setFollowDistance(value){
  var meters=Number(value);
  if(!Number.isFinite(meters)||meters<0){return;}
  lastFollow.gap=meters;
  setBehaviorFlag('followDistance',meters,function(){
    logLine('间距：'+meters+' m'+followSummary());
  });
}
// 「清空间距」：followDistance=-1 → 阶梯/环形都不会移动（0.6.8 起没有"分层环绕"这条兜底了）。
function followLayeredOrder(){
  lastFollow.gap=-1;
  setBehaviorFlag('followDistance',-1,function(){
    logLine('间距已清空：船会停在原地，直到重新设置间距');
  });
}
// 阶梯步长（第 2 艘起依次外扩）；环形时面板会把它灰掉。空值回落默认 100（不是 0）。
function applyCrewSpacing(){
  var input=document.getElementById('crewSpacing');
  var raw=input?String(input.value).trim():'';
  var meters=raw===''?100:Number(raw);
  if(!Number.isFinite(meters)||meters<0){meters=100;}
  if(input){input.value=String(meters);}
  lastFollow.spacing=meters;
  setBehaviorFlag('crewSpacingMeters',meters,function(){
    logLine('步长：'+meters+' m'+followSummary());
  });
}
// 跟随阵型：静止 / 跟随 / 阶梯 / 环形（0.6.8 起"停船"不在这里，见「停船」按钮 → /crewmine halt）
function setFollowFormation(value){
  var mode=(value==='idle'||value==='ring'||value==='follow')?value:'ladder';
  var label=mode==='ring'?'环形（同一圈）':(mode==='idle'?'静止':(mode==='follow'?'跟随（同一距离）':'同心环（距离递增）'));
  lastFollow.mode=mode;
  setBehaviorFlag('followFormation',mode,function(){
    logLine('编队阵型：'+label+followSummary());
  });
}
// 所有"改配置"的请求都走这里：POST /api/mode + 统一错误处理。
function postMode(body,onOk){
  fetch('/api/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json();})
    .then(function(j){
      if(!j||j.ok===false){logLine('切换失败：'+((j&&j.error)||'未知'));return;}
      if(typeof onOk==='function'){onOk(j);}
    }).catch(function(e){logLine('切换请求失败：'+e);});
}
function setBehaviorFlag(key,value,after){
  postMode({field:key,value:value},function(){if(typeof after==='function'){after();}});
}
function syncChase(s){
  var btn=document.getElementById('chaseToggle');
  if(!btn){return;}
  var on=Boolean(s&&s.chaseOutOfRange);
  chaseOn=on;
  if(on){
    btn.textContent='追击：开';
    btn.classList.add('danger');
    btn.title='已开启：目标在射程外时会主动靠近（到射程的 70%）';
  }else{
    btn.textContent='追击：关';
    btn.classList.remove('danger');
    btn.title='已关闭：打不到就原地等';
  }
}
function toggleFullAuthority(){
  var on=!fullAuthorityOn;
  cmd(on?'attack full':'attack off');
  logLine('末日武器授权 '+(on?'开启（冷却结束自动发射）':'收回'));
  syncFullAuthority({fullAuthority:on});
}
function syncFullAuthority(s){
  var btn=document.getElementById('fullAuthority');
  if(!btn){return;}
  var on=Boolean(s&&s.fullAuthority);
  fullAuthorityOn=on;
  if(on){
    btn.textContent='末日扫射';
    btn.classList.add('danger');
    btn.title='末日武器已授权：冷却结束会自动发射（再点一次收回授权）';
  }else{
    btn.textContent='末日武器授权';
    btn.classList.remove('danger');
    btn.title='授权末日武器：冷却结束自动发射';
  }
}
function drawMiniMap(entries){
  var svg=document.getElementById('miniMap');
  if(!svg){return;}
  var size=180,half=size/2,maxRange=60000;
  var parts=['<circle cx="'+half+'" cy="'+half+'" r="'+(half-4)+'" fill="none" stroke="#2b3240"/>'];
  parts.push('<circle cx="'+half+'" cy="'+half+'" r="3" fill="#7fd4ff"/>');
  (entries||[]).forEach(function(e){
    var o=e.offset;
    if(!o){return;}
    var scale=(half-8)/maxRange;
    var x=half+(Number(o.x)||0)*scale, y=half+(Number(o.y)||0)*scale;
    var dist=Math.hypot(x-half,y-half);
    if(dist>half-8){var k=(half-8)/dist;x=half+(x-half)*k;y=half+(y-half)*k;}
    var color=(e.mode==='WARP')?'#e2b93b':(e.active?'#e06c75':'#6fcf97');
    parts.push('<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="4" fill="'+color+'"><title>'+esc(e.name||'')+'</title></circle>');
  });
  svg.innerHTML=parts.join('');
}
var crewLogOffset=0;
var crewLogBusy=false;
function appendCrewLog(text){
  var view=document.getElementById('crewLogView');
  if(!view||!text){return;}
  var atBottom=view.scrollTop+view.clientHeight>=view.scrollHeight-24;
  // 用 append 而不是整体替换 textContent：替换会把滚动位置重置到顶部。
  view.appendChild(document.createTextNode(text));
  if(view.textContent.length>240000){
    view.textContent=view.textContent.slice(-200000);
  }
  if(atBottom){view.scrollTop=view.scrollHeight;}
}
function setDebugMode(on){
  fetch('/api/debug',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({on:on?'true':'false'})})
    .then(function(r){return r.json();})
    .then(function(j){
      var box=document.getElementById('debugToggle');
      if(box&&j&&typeof j.debug==='boolean'){box.checked=j.debug;}
      logLine('调试日志 '+(j&&j.debug?'已开启（会记录装备与行为）':'已关闭（不记录装备/行为日志）'));
    }).catch(function(e){logLine('调试开关失败：'+e);});
}
function syncDebugToggle(s){
  var box=document.getElementById('debugToggle');
  if(box&&s&&typeof s.debug==='boolean'&&box.checked!==s.debug){box.checked=s.debug;}
}
function initSplitter(){
  var left=document.getElementById('leftPane');
  var map=document.getElementById('mapRail');
  if(!left||!map){return;}
  function clamp(w,min,max){return Math.max(min,Math.min(max,Math.round(w)));}
  function setLeft(w){left.style.flex='0 0 '+clamp(w,420,1400)+'px';}
  function setMap(w){map.style.flex='0 0 '+clamp(w,160,480)+'px';}
  try{
    setLeft(Number(localStorage.getItem('nfLeftWidth'))||780);
    setMap(Number(localStorage.getItem('nfMapWidth'))||212);
  }catch(e){}
  function wire(handleId,onMove,onDone){
    var handle=document.getElementById(handleId);
    if(!handle){return;}
    var dragging=false;
    handle.addEventListener('mousedown',function(ev){
      dragging=true;ev.preventDefault();
      document.body.style.cursor='col-resize';
      document.body.style.userSelect='none';
    });
    window.addEventListener('mousemove',function(ev){
      if(!dragging){return;}
      onMove(ev);
    });
    window.addEventListener('mouseup',function(){
      if(!dragging){return;}
      dragging=false;
      document.body.style.cursor='';
      document.body.style.userSelect='';
      if(onDone){onDone();}
    });
  }
  // ① 左列右边缘：跟手改左列宽度（详情栏自动吃掉剩余空间，不再反过来动左列）
  wire('splitterLeft',function(ev){
    var rect=left.getBoundingClientRect();
    setLeft(ev.clientX-rect.left);
  },function(){
    var m=left.style.flex.match(/\d+/g);
    try{if(m){localStorage.setItem('nfLeftWidth',m[m.length-1]);}}catch(e){}
  });
  // ② 地图左边缘：跟手改地图宽度（左列与详情栏都不动）
  wire('splitter',function(ev){
    var rect=map.getBoundingClientRect();
    setMap(rect.right-ev.clientX);
  },function(){
    var m=map.style.flex.match(/\d+/g);
    try{if(m){localStorage.setItem('nfMapWidth',m[m.length-1]);}}catch(e){}
  });
  // ③ 地图底部：上下拖拽改地图高度（正方形会按较小边自适应）
  var card=document.getElementById('mapCard');
  var handle=document.getElementById('mapHandle');
  if(card&&handle){
    var savedHeight=0;
    try{savedHeight=Number(localStorage.getItem('nfMapHeight'))||0;}catch(e){}
    function setHeight(h){card.style.height=clamp(h,120,600)+'px';}
    if(savedHeight){setHeight(savedHeight);}
    var vDrag=false;
    handle.addEventListener('mousedown',function(ev){
      vDrag=true;ev.preventDefault();
      document.body.style.cursor='row-resize';
      document.body.style.userSelect='none';
    });
    window.addEventListener('mousemove',function(ev){
      if(!vDrag){return;}
      var rect=card.getBoundingClientRect();
      setHeight(ev.clientY-rect.top);
    });
    window.addEventListener('mouseup',function(){
      if(!vDrag){return;}
      vDrag=false;
      document.body.style.cursor='';
      document.body.style.userSelect='';
      var m=card.style.height.match(/\d+/g);
      try{if(m){localStorage.setItem('nfMapHeight',m[m.length-1]);}}catch(e){}
    });
  }
}
function setModeField(field, value, characterID){
  var body={field:field,value:value===true};
  if(characterID){body.characterID=Number(characterID);}
  postMode(body,function(j){
    logLine('已切换 '+field+' = '+(value?'开':'关')+(j.written?('（'+j.written+' 个蓝图）'):''));
    if(characterID&&selectedCrew===Number(characterID)){fetchDetail();}
  });
}
function toggleCrewNpc(){
  if(!selectedCrew){logLine('先选一个船员');return;}
  var pane=document.getElementById('detailPane');
  var on=(pane.innerHTML||'').indexOf('modeBadge npc')<0;
  setModeField('npcMode',on,selectedCrew);
}
function syncSettleMode(s){
  var chip=document.getElementById('settleMode');
  if(!chip){return;}
  var salvo=s&&s.weaponSalvo!==false;
  var npcAll=s&&s.npcModeDefault===true;
  var text=[];
  text.push(salvo?'齐射结算':'逐门激活');
  text.push(npcAll?'NPC 模式':'玩家模式');
  chip.textContent=text.join(' · ');
  chip.className='badge '+(npcAll?'on':'');
  var salvoBox=document.getElementById('salvoToggle');
  if(salvoBox&&salvoBox.checked!==salvo){salvoBox.checked=salvo;}
  var npcBox=document.getElementById('npcToggle');
  if(npcBox&&npcBox.checked!==npcAll){npcBox.checked=npcAll;}
  var distSel=document.getElementById('followDist');
  // 别在用户正在操作（或刚改过还没提交）时把下拉刷回去 —— 这就是"总变成未设置"的元凶。
  var distBusy=distSel&&(document.activeElement===distSel||Date.now()-followDistTouchedAt<5000);
  if(distSel&&!distBusy&&typeof s.followDistance==='number'){
    var wanted=String(s.followDistance);
    for(var i=0;i<distSel.options.length;i++){if(distSel.options[i].value===wanted){distSel.value=wanted;break;}}
  }
}
function pollCrewLog(){
  if(crewLogBusy){return;}
  crewLogBusy=true;
  fetch('/api/log?offset='+crewLogOffset).then(function(r){return r.json();}).then(function(j){
    if(j&&typeof j.offset==='number'){crewLogOffset=j.offset;}
    appendCrewLog(j&&j.text?j.text:'');
    var info=document.getElementById('crewLogInfo');
    if(info){info.textContent='偏移 '+(crewLogOffset||0)+' 字节';}
  }).catch(function(){}).finally(function(){crewLogBusy=false;});
}
// 清理 3 天前的日志（服务端按行首时间戳剪）。
function pruneLogs(days){
  var d=Number(days)||3;
  fetch('/api/log/prune?days='+d,{method:'POST'})
    .then(function(r){return r.json();})
    .then(function(j){
      if(!j||j.ok!==true){logLine('清理日志失败：'+((j&&j.error)||'未知'));return;}
      logLine('已清理 '+d+' 天前的日志：删除 '+Number(j.removedLines||0)+' 行 / '+Number(j.deletedFiles||0)+' 个轮转文件');
      resetCrewLog();
    }).catch(function(e){logLine('清理日志请求失败：'+e);});
}
// 清空所有日志：先弹警告确认（清掉之后出问题就不好查了）。
function clearAllLogs(){
  var ok=confirm('警告：这会清空全部船员日志（含已轮转的历史文件）。\n\n清空后如果出现异常，就没有日志可以排查了。\n\n确定要清理所有日志吗？');
  if(!ok){return;}
  fetch('/api/log/clear',{method:'POST'})
    .then(function(r){return r.json();})
    .then(function(j){
      if(!j||j.ok!==true){logLine('清空日志失败：'+((j&&j.error)||'未知'));return;}
      logLine('已清空所有日志：释放 '+Math.round(Number(j.clearedBytes||0)/1024)+' KB，删除 '+Number(j.deletedFiles||0)+' 个轮转文件');
      resetCrewLog();
    }).catch(function(e){logLine('清空日志请求失败：'+e);});
}
function resetCrewLog(){
  crewLogOffset=0;
  var view=document.getElementById('crewLogView');
  if(view){view.textContent='';}
  pollCrewLog();
}
var es=new EventSource('/api/stream'+(cmToken?'?token='+encodeURIComponent(cmToken):''));
es.onmessage=function(ev){try{setConn(true);var s=JSON.parse(ev.data);render(s);syncButtons(((s&&s.entries)||[]).length>0);}catch(e){}};
es.onerror=function(){setConn(false);};
// Ask once who we are: a 401 shows the token box, a 200 leaves the page as is.
fetch('/api/whoami').then(function(r){return r.ok?r.json():null;}).then(function(who){
  if(who&&who.accountID!==undefined){
    var tag=document.getElementById('conn');
    if(tag&&!tag.title){tag.title='账号 '+who.accountID;}
  }
}).catch(function(){});

// ==== P2：召唤仓库窗口 =====================================================
var stockPageSize = 20;
var stockQuery = '';
var stockSearchTimer = null;
var stockOffset = 0;
var stockShips = [];
var stockSelected = {};
var stockView = null;

function showTab(name){
  var main = document.querySelector('main');
  var stockPane = document.getElementById('stockPane');
  var fitPane = document.getElementById('fitPane');
  var settingsPane = document.getElementById('settingsPane');
  var isStock = name === 'stock';
  var isFit = name === 'fit';
  var isSettings = name === 'settings';
  if (main) { main.hidden = isStock || isFit || isSettings; }
  if (stockPane) { stockPane.hidden = !isStock; }
  if (fitPane) { fitPane.hidden = !isFit; }
  if (settingsPane) { settingsPane.hidden = !isSettings; }
  var tabs = {
    command: document.getElementById('tabCommand'),
    stock: document.getElementById('tabStock'),
    fit: document.getElementById('tabFit'),
    settings: document.getElementById('tabSettings')
  };
  Object.keys(tabs).forEach(function(key){
    if (tabs[key]) { tabs[key].className = 'tab' + (key === name ? ' active' : ''); }
  });
  if (isStock) { syncStockPresets(); loadStock(); }
  if (isFit) { loadFitCatalog(); }
}

function stockLog(text){
  if (typeof logLine === 'function') { logLine(text); }
  var msg = document.getElementById('stockBuyMsg');
  if (msg) { msg.textContent = text; }
}

function fmtIsk(value){
  var n = Number(value);
  if (!isFinite(n) || n <= 0) { return '—'; }
  return n.toLocaleString('en-US') + ' ISK';
}

function linesText(res, fallback){
  if (res && Array.isArray(res.lines)) { return res.lines.join(' | '); }
  if (res && res.lines) { return String(res.lines); }
  if (res && res.error) { return String(res.error); }
  return String(fallback || '没有返回');
}

function stockPost(path, body){
  return fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body || {})})
    .then(function(r){ return r.json().then(function(j){ return j; }); });
}

function stockSearchChanged(){
  var input = document.getElementById('stockSearch');
  stockQuery = String((input && input.value) || '').trim();
  if (stockSearchTimer) { clearTimeout(stockSearchTimer); }
  // 输入停顿 250ms 再请求，避免每敲一个字打一次接口
  stockSearchTimer = setTimeout(function(){
    stockOffset = 0;
    loadStock();
  }, 250);
}

function stockPageSizeChanged(){
  var sel = document.getElementById('stockPageSize');
  stockPageSize = Math.max(1, Math.trunc(Number(sel && sel.value)) || 20);
  stockOffset = 0;
  loadStock();
}

function loadStock(){
  fetch('/api/stock?offset=' + stockOffset + '&limit=' + stockPageSize
    + '&query=' + encodeURIComponent(stockQuery))
    .then(function(r){ return r.json(); })
    .then(function(view){ renderStock(view); })
    .catch(function(e){ stockLog('读库存失败：' + e); });
}

function renderStock(view){
  stockView = view || {};
  stockShips = (view && view.ships) || [];
  var wh = document.getElementById('stockWarehouse');
  if (wh) {
    wh.textContent = view && view.warehouse
      ? (view.warehouse.name + '（' + view.warehouse.characterID + '）')
      : '还没建（运行 /crewmine stock init）';
  }
  var bal = document.getElementById('stockBalance');
  if (bal) { bal.textContent = fmtIsk(view && view.balance); }
  var counts = (view && view.counts && view.counts.counts) || {};
  var cnt = document.getElementById('stockCounts');
  if (cnt) {
    cnt.textContent = '在库 ' + (counts.stored || 0) + ' / 在用 ' + (counts.in_use || 0)
      + ' / 丢失 ' + (counts.lost || 0) + ' · 共 ' + ((view && view.total) || 0) + ' 条'
      + ' · 累计花掉 ' + fmtIsk(view && view.spent) + ' / 退回 ' + fmtIsk(view && view.refunded);
  }
  var tg = document.getElementById('stockToggle');
  if (tg) { tg.textContent = view && view.enabled ? '库存：开' : '库存：关'; tg.className = view && view.enabled ? 'primary' : ''; }

  var rows = document.getElementById('stockRows');
  if (!rows) { return; }
  if (!stockShips.length) {
    rows.innerHTML = '<div class="muted">库存是空的：上面订几艘，或把机库里的船转进来</div>';
  } else {
    rows.innerHTML = stockShips.map(function(s){
      // 点卡片选中（绿）；在用=蓝；丢失=红。只有 stored 能选。
      var stateClass = s.state === 'in_use' ? ' inuse' : (s.state === 'lost' ? ' lost' : '');
      var selClass = stockSelected[s.id] ? ' sel' : '';
      var stateText = s.state === 'in_use' ? ('在用 @' + s.characterID) : (s.state === 'stored' ? '在库' : (s.state === 'lost' ? '已丢失' : s.state));
      var sourceText = s.source === 'bought' ? '购入' : (s.source === 'existing' ? '自有' : s.source);
      var price = s.source === 'bought' ? fmtIsk(s.pricePaid) : '自有';
      return '<div class="stockCard' + stateClass + selClass + '" data-id="' + s.id + '" data-state="' + s.state + '"'
        + ' onclick="stockCardClick(this)">'
        + '<div class="stockMain">'
        +   '<div class="cardHead"><b>' + (s.name || '') + '</b> <span class="muted">' + s.id + '</span></div>'
        +   '<div class="cardLine muted">' + stateText + ' · ' + sourceText + ' · ' + price + '</div>'
        + '</div>'
        // 丢了的船给一个「重购」：按同一配装再买一艘（80% 价，进仓库）
        + (s.state === 'lost'
          ? '<button class="rebuy" onclick="event.stopPropagation(); stockRebuy(\'' + s.id + '\')" title="按同一配装重买一艘">重购</button>'
          : '<button onclick="event.stopPropagation(); stockSummonOne(\'' + s.id + '\')"'
            + (s.state === 'stored' ? '' : ' disabled') + '>召唤</button>')
        + '</div>';
    }).join('');
  }
  var info = document.getElementById('stockPageInfo');
  if (info) {
    var total = (view && view.total) || 0;
    var from = total === 0 ? 0 : stockOffset + 1;
    var to = Math.min(stockOffset + stockPageSize, total);
    info.textContent = from + '–' + to + ' / ' + total;
  }
  lastPlans = (view && view.plans) || [];
  if (planPaneOpen) { renderPlanPane(); }
  updateSelCount();
}

// ---- 召唤方案窗口（和「转入机库船」一样独立占据下方） ----------------------
var planPaneOpen = false;
var planDetail = null;   // 非空 = 正在看某个方案的详情
var lastPlans = [];

function togglePlanPane(){
  if (planPaneOpen) { closePlanPane(); } else { openPlanPane(); }
}

function openPlanPane(){
  var pane = document.getElementById('planPane');
  var main = document.getElementById('stockMainView');
  var btn = document.getElementById('planToggleBtn');
  if (!pane) { return; }
  if (hangarOpen) { closeHangarPane(); }
  planPaneOpen = true;
  planDetail = null;
  if (main) { main.hidden = true; }
  pane.hidden = false;
  if (btn) { btn.className = 'active'; }
  renderPlanPane();
  loadStock();
}

function closePlanPane(){
  planPaneOpen = false;
  planDetail = null;
  var pane = document.getElementById('planPane');
  var main = document.getElementById('stockMainView');
  var btn = document.getElementById('planToggleBtn');
  if (pane) { pane.hidden = true; }
  if (main) { main.hidden = false; }
  if (btn) { btn.className = ''; }
}

function renderPlanPane(){
  var body = document.getElementById('planBody');
  var info = document.getElementById('planInfo');
  if (!body) { return; }
  if (planDetail) { renderPlanDetail(planDetail); return; }
  if (info) { info.textContent = lastPlans.length + ' 个方案'; }
  var html = '';
  if (!lastPlans.length) {
    html = '<div class="muted">还没有方案：回仓库勾选几条船、填个方案名，点「创建召唤方案」</div>';
  } else {
    // 一行多列：每个方案一张卡
    html = '<div class="gridCards">' + lastPlans.map(function(p){
      return '<div class="planCard">'
        + '<div class="cardHead"><b>' + p.name + '</b> <span class="muted">' + p.id + '</span></div>'
        + '<div class="cardLine muted">方案内 ' + p.count + ' 艘</div>'
        + '<div class="cardOps">'
        + '<button class="primary" onclick="summonPlan(\'' + p.id + '\')">一键召唤</button>'
        + '<button onclick="showPlanDetail(\'' + p.id + '\')">查看详细</button>'
        + '<button onclick="deletePlan(\'' + p.id + '\')">删除</button>'
        + '</div></div>';
    }).join('') + '</div>';
  }
  body.innerHTML = html;
}

function showPlanDetail(planID){
  stockPost('/api/stock/plan', {action: 'detail', planID: planID}).then(function(res){
    if (!res || res.ok !== true) { stockLog(linesText(res).slice(0, 200)); return; }
    planDetail = res;
    renderPlanPane();
  });
}

function closePlanDetail(){
  planDetail = null;
  renderPlanPane();
}

function renderPlanDetail(detail){
  var body = document.getElementById('planBody');
  var info = document.getElementById('planInfo');
  if (!body) { return; }
  var plan = detail.plan || {};
  if (info) { info.textContent = plan.name + ' · ' + (detail.ships || []).length + ' 艘在库'; }
  var ships = detail.ships || [];
  var html = '<div style="margin-bottom:8px"><button onclick="closePlanDetail()">← 返回方案列表</button>'
    + ' <button class="primary" onclick="summonPlan(\'' + (plan.id || '') + '\')">一键召唤这个方案</button>'
    + '<span class="muted" style="margin-left:8px">' + (detail.lines || []).join(' · ') + '</span></div>';
  if (!ships.length) {
    html += '<div class="muted">这个方案目前没有可用的在库船</div>';
  } else {
    html += '<div class="gridCards">' + ships.map(function(s){
      return '<div class="stockCard" data-id="' + s.id + '">'
        + '<div class="stockMain"><div class="cardHead"><b>' + (s.name || '') + '</b> <span class="muted">' + s.id + '</span></div>'
        + '<div class="cardLine muted">' + (s.group || '') + ' · 船 ' + s.itemID + ' · ' + (s.source === 'bought' ? fmtIsk(s.pricePaid) : '自有') + '</div></div>'
        + '<button onclick="event.stopPropagation(); stockSummonOne(\'' + s.id + '\')">召唤</button>'
        + '</div>';
    }).join('') + '</div>';
  }
  body.innerHTML = html;
}

function stockCardClick(card){
  var id = card && card.getAttribute('data-id');
  var state = card && card.getAttribute('data-state');
  if (!id) { return; }
  if (state !== 'stored') {
    stockLog(state === 'in_use' ? '这艘在用（在船员的船上），不能选' : '这艘已丢失，不能选');
    return;
  }
  if (stockSelected[id]) {
    delete stockSelected[id];
    card.classList.remove('sel');
  } else {
    stockSelected[id] = true;
    card.classList.add('sel');
  }
  updateSelCount();
}

function toggleAllShips(){
  var selectable = stockShips.filter(function(s){ return s.state === 'stored'; });
  var allSelected = selectable.length > 0 && selectable.every(function(s){ return stockSelected[s.id]; });
  if (allSelected) {
    stockSelected = {};
  } else {
    stockSelected = {};
    selectable.forEach(function(s){ stockSelected[s.id] = true; });
  }
  renderStock(stockView);
  var btn = document.getElementById('stockAllBtn');
  if (btn) { btn.textContent = allSelected ? '全选本页' : '清空选择'; }
}

function updateSelCount(){
  var n = Object.keys(stockSelected).length;
  var el = document.getElementById('stockSelCount');
  if (el) { el.textContent = n + ' 选中'; }
}

function stockSelectedList(){
  return Object.keys(stockSelected).filter(function(id){ return stockSelected[id]; });
}

function stockSummonOne(id){
  stockSelected = {};
  stockSelected[id] = true;
  stockSummonSelected();
}

function stockRebuy(id){
  if (!id) { return; }
  if (!confirm('按同一配装重买一艘（80% 卖价）？')) { return; }
  stockLog('重购中…');
  stockPost('/api/stock/rebuy', {id: id}).then(function(res){
    stockLog(linesText(res).slice(0, 240));
    loadStock();
  });
}

function stockSummonSelected(){
  var ids = stockSelectedList();
  if (!ids.length) { stockLog('先勾选要召唤的船'); return; }
  stockLog('召唤 ' + ids.length + ' 艘…');
  stockPost('/api/stock/summon', {ids: ids}).then(function(res){
    stockLog(linesText(res).slice(0, 240));
    stockSelected = {};
    loadStock();
    if (typeof refresh === 'function') { try { refresh(); } catch (e) {} }
  });
}

function stockSellSelected(){
  var ids = stockSelectedList();
  if (!ids.length) { stockLog('先勾选要卖的船'); return; }
  if (!confirm('卖出 ' + ids.length + ' 艘（只对购入的船生效，按实付价退）？')) { return; }
  stockPost('/api/stock/sell', {ids: ids}).then(function(res){
    stockLog(linesText(res).slice(0, 240));
    stockSelected = {};
    loadStock();
  });
}

function stockWithdrawSelected(){
  var ids = stockSelectedList();
  if (!ids.length) { stockLog('先勾选要取出的船'); return; }
  stockPost('/api/stock/withdraw', {ids: ids}).then(function(res){
    stockLog(linesText(res).slice(0, 240));
    stockSelected = {};
    loadStock();
  });
}

// ---- P4 界面：机库面板（独占下方整个区域，逐艘勾选）------------------------
var hangarShips = [];
var hangarOpen = false;

function toggleHangarPane(){
  if (hangarOpen) { closeHangarPane(); } else { openHangarPane(); }
}

function openHangarPane(){
  var pane = document.getElementById('hangarPane');
  var mainView = document.getElementById('stockMainView');
  var list = document.getElementById('hangarList');
  var info = document.getElementById('hangarInfo');
  var btn = document.getElementById('hangarToggleBtn');
  if (!pane || !list) { return; }
  hangarOpen = true;
  if (mainView) { mainView.hidden = true; }
  pane.hidden = false;
  if (btn) { btn.className = 'active'; }
  list.innerHTML = '<div class="muted">读取机库…</div>';
  if (info) { info.textContent = ''; }
  fetch('/api/stock/hangar').then(function(r){ return r.json(); }).then(function(res){
    if (!res || res.ok !== true) {
      hangarShips = [];
      list.innerHTML = '<div class="muted">' + ((res && (res.message || res.error)) || '读不到机库') + '</div>';
      if (info) { info.textContent = '0 艘'; }
      return;
    }
    hangarShips = (res.ships || []);
    if (info) { info.textContent = hangarShips.length + ' 艘（正在驾驶的不能转入）'; }
    if (!hangarShips.length) {
      list.innerHTML = '<div class="muted">你在吉他 4-4 机库里没有可转入的船。'
        + '（要先把船停到吉他 4-4 —— 站 60003760；正在开的那艘不能转）</div>';
      return;
    }
    list.innerHTML = hangarShips.map(function(s){
      var disabled = s.flying ? ' disabled' : '';
      return '<label class="hangarCard' + (s.flying ? ' flying' : '') + '">'
        + '<input type="checkbox" data-item="' + s.itemID + '"' + disabled + '>'
        + '<span class="hangarName">' + (s.name || ('船 ' + s.itemID)) + '</span>'
        + '<span class="muted">type ' + s.typeID + ' · item ' + s.itemID + (s.flying ? ' · 正在驾驶' : '') + '</span>'
        + '</label>';
    }).join('');
  }).catch(function(e){
    list.innerHTML = '<div class="muted">读机库失败：' + e + '</div>';
  });
}

function closeHangarPane(){
  hangarOpen = false;
  var pane = document.getElementById('hangarPane');
  var mainView = document.getElementById('stockMainView');
  var btn = document.getElementById('hangarToggleBtn');
  if (pane) { pane.hidden = true; }
  if (mainView) { mainView.hidden = false; }
  if (btn) { btn.className = ''; }
}

function hangarSelected(){
  var out = [];
  var boxes = document.querySelectorAll('#hangarList input[type=checkbox]');
  for (var i = 0; i < boxes.length; i += 1) {
    if (boxes[i].checked && !boxes[i].disabled) {
      out.push(Number(boxes[i].getAttribute('data-item')));
    }
  }
  return out;
}

function depositHangarSelected(){
  var ids = hangarSelected();
  if (!ids.length) { stockLog('先勾选要转入的船'); return; }
  stockPost('/api/stock/deposit', {ids: ids}).then(function(res){
    stockLog(linesText(res).slice(0, 240));
    closeHangarPane();
    loadStock();
  });
}

function depositHangarAll(){
  var ids = hangarShips.filter(function(s){ return !s.flying; }).map(function(s){ return s.itemID; });
  if (!ids.length) { stockLog('机库里没有可转入的船'); return; }
  stockPost('/api/stock/deposit', {ids: ids}).then(function(res){
    stockLog(linesText(res).slice(0, 240));
    closeHangarPane();
    loadStock();
  });
}
function stockBuy(){
  var sel = document.getElementById('stockPreset');
  var cnt = document.getElementById('stockBuyCount');
  var blueprintID = sel && sel.value ? String(sel.value) : '';
  var count = Number(cnt && cnt.value) || 1;
  if (!blueprintID) { stockLog('先选一条蓝图'); return; }
  stockLog('订货中（按 80% 卖价）…');
  stockPost('/api/stock/buy', {blueprintID: blueprintID, count: count}).then(function(res){
    stockLog(linesText(res).slice(0, 240));
    loadStock();
  });
}

function stockReconcile(){
  stockPost('/api/stock/reconcile', {}).then(function(res){
    stockLog(linesText(res).slice(0, 240));
    loadStock();
  });
}

function toggleStockEnabled(){
  var on = !(stockView && stockView.enabled);
  stockPost('/api/cmd', {text: on ? 'stock on' : 'stock off'}).then(function(res){
    stockLog(String(res.reply || res.error || '').slice(0, 240));
    loadStock();
  });
}

function stockPage(delta){
  var next = stockOffset + delta * stockPageSize;
  if (next < 0) { return; }
  var total = (stockView && stockView.total) || 0;
  if (next >= total && delta > 0) { return; }
  stockOffset = next;
  loadStock();
}

function createPlan(){
  var nameEl = document.getElementById('planName');
  var name = (nameEl && nameEl.value || '').trim();
  var ids = stockSelectedList();
  if (!name) { planMsg('方案要有个名字'); return; }
  if (!ids.length) { planMsg('先在仓库里勾选要放进方案的船'); return; }
  stockPost('/api/stock/plan', {action: 'create', name: name, ids: ids}).then(function(res){
    planMsg(linesText(res).slice(0, 240));
    if (nameEl) { nameEl.value = ''; }
    loadStock();
  });
}

function deletePlan(id){
  if (!confirm('删除方案 ' + id + '？')) { return; }
  stockPost('/api/stock/plan', {action: 'delete', planID: id}).then(function(res){
    planMsg(linesText(res).slice(0, 240));
    loadStock();
  });
}

function summonPlan(id){
  stockPost('/api/stock/plan', {action: 'summon', planID: id}).then(function(res){
    planMsg(linesText(res).slice(0, 240));
    loadStock();
  });
}

/** 方案窗口里的提示：写到 planInfo（窗口打开时 stockBuyMsg 看不见）。 */
function planMsg(text){
  var info = document.getElementById('planInfo');
  if (info) { info.textContent = String(text || '').slice(0, 200); }
  stockLog(text);
}

// 蓝图下拉：和「指挥」页那个 #preset 保持同一份列表。
function syncStockPresets(){
  var src = document.getElementById('preset');
  var dst = document.getElementById('stockPreset');
  if (!src || !dst) { return; }
  if (dst.getAttribute('data-sig') === String(src.length) + ':' + (src.value || '')) { return; }
  dst.innerHTML = src.innerHTML;
  dst.value = src.value;
  dst.setAttribute('data-sig', String(src.length) + ':' + (src.value || ''));
}

// ==== P3：配装台 ===========================================================
// 槽位按家族分区（高/中/低/改装/子系统）；每个槽位是独立卡片。
// 选择器是「原生下拉的样子 + 面板顶部一个搜索框」：收起时只看得到当前值，
// 点开才出现搜索框和选项列表。选项按 槽位家族 + 改装件尺寸 + 剩余 CPU/PG 过滤。
var FIT_SECTIONS = [
  {family: "high", label: "高槽", attr: "hi", base: 27},
  {family: "med", label: "中槽", attr: "me", base: 19},
  {family: "low", label: "低槽", attr: "lo", base: 11},
  {family: "rig", label: "改装件", attr: "rig", base: 92},
  {family: "subsystem", label: "子系统", attr: "sub", base: 125}
];

var fitState = {
  ships: null,
  modules: {},     // family -> [module]
  byType: {},      // typeID -> module
  chargeCache: {}, // moduleTypeID -> [charge]
  hull: 0,
  hullRow: null,
  selected: {},    // flagID -> {typeID}
  charges: {},     // flagID -> chargeTypeID
  clipboard: null, // {typeID, chargeTypeID} 槽位复制/粘贴
  truncated: null  // 旧后端截断模块列表时的提示
};

function fitMsg(text) {
  var el = document.getElementById('fitMsg');
  if (el) { el.textContent = text; }
  if (typeof logLine === 'function' && text) { logLine(text); }
}

function onlyFittable() {
  var box = document.getElementById('fitOnlyFittable');
  return !box || box.checked;
}

// ---- 下拉选择器（外观像 select，面板顶部带搜索）---------------------------

function closeAllSelects() {
  var panels = document.querySelectorAll('.nfSelectPanel');
  for (var i = 0; i < panels.length; i += 1) { panels[i].hidden = true; }
}

function toggleSelect(button) {
  var holder = button.closest('.nfSelect');
  if (!holder) { return; }
  var panel = holder.querySelector('.nfSelectPanel');
  if (!panel) { return; }
  if (!panel.hidden) { panel.hidden = true; return; }
  closeAllSelects();
  panel.hidden = false;
  var search = panel.querySelector('.nfSelectSearch');
  if (search) {
    search.value = '';
    renderSelectList(holder, '');
    if (search.focus) { search.focus(); }
  }
}

function filterSelect(input) {
  var holder = input.closest('.nfSelect');
  if (holder) { renderSelectList(holder, input.value); }
}

function selectKey(event, input) {
  var holder = input.closest('.nfSelect');
  if (!holder) { return; }
  if (event.key === 'Escape') {
    closeAllSelects();
    return;
  }
  var items = holder.querySelectorAll('.nfSelectItem');
  if (!items.length) { return; }
  if (event.key === 'Enter') {
    event.preventDefault();
    items[0].dispatchEvent(new MouseEvent('mousedown'));
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    var current = -1;
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].classList.contains('hl')) { current = i; break; }
    }
    var next = event.key === 'ArrowDown' ? Math.min(items.length - 1, current + 1) : Math.max(0, current - 1);
    for (var j = 0; j < items.length; j += 1) { items[j].classList.remove('hl'); }
    items[next].classList.add('hl');
    if (items[next].scrollIntoView) { items[next].scrollIntoView({block: 'nearest'}); }
  }
}

function renderSelectList(holder, query) {
  var list = holder.querySelector('.nfSelectList');
  if (!list) { return; }
  var q = String(query || '').trim().toLowerCase();
  var rows = [];
  if (holder.id === 'fitHullSelect') {
    rows = rankByQuery((fitState.ships || []).filter(function (h) {
      return !q || String(h.n || '').toLowerCase().indexOf(q) >= 0 || String(h.typeID) === q;
    }), q).slice(0, 200).map(function (h) {
      return itemHtml(h.typeID, esc(h.n), '高' + (h.hi || 0) + '/中' + (h.me || 0) + '/低' + (h.lo || 0)
        + (h.rig ? '/改装' + h.rig : '') + (h.turret ? '/炮台' + h.turret : '') + (h.launcher ? '/发射器' + h.launcher : '')
        + (h.sub ? '/子系统' + h.sub : ''), 0);
    });
  } else if (holder.hasAttribute('data-charge')) {
    // 弹药选择：选项来自当前模块的弹药组，同样面板顶部带搜索。
    var chargeCard = holder.closest('.fitSlotCard');
    var chargeFlag = chargeCard ? Number(chargeCard.getAttribute('data-flag')) || 0 : 0;
    var picked = fitState.selected[chargeFlag];
    var charges = picked && picked.typeID ? (fitState.chargeCache[picked.typeID] || []) : [];
    if (q) {
      charges = charges.filter(function (c) {
        return String(c.n || '').toLowerCase().indexOf(q) >= 0 || String(c.typeID) === q;
      });
    }
    rows = [itemHtml(0, '（不装弹药）', '', 0)].concat(charges.slice(0, 300).map(function (c) {
      return itemHtml(c.typeID, esc(c.n), '', 0);
    }));
  } else {
    var card = holder.closest('.fitSlotCard');
    if (!card) { return; }
    var flag = Number(card.getAttribute('data-flag')) || 0;
    var family = card.getAttribute('data-family');
    var section = FIT_SECTIONS.find(function (s) { return s.family === family; });
    if (!section) { return; }
    var options = fitOptionsFor(section, flag, onlyFittable());
    if (q) {
      options = options.filter(function (m) {
        return String(m.n || '').toLowerCase().indexOf(q) >= 0 || String(m.typeID) === q;
      });
    }
    // 前缀命中的排前面：搜「大型」时「大型护盾扩展装置」不该被「超大型…」压在下面。
    options = rankByQuery(options, q);
    var shown = options.slice(0, 300);
    rows = [itemHtml(0, '（空）', '', 0)].concat(shown.map(function (m) {
      return itemHtml(m.typeID, esc(m.n), 'CPU ' + (m.cpu || 0) + ' / PG ' + (m.pg || 0), 0);
    }));
    if (options.length > shown.length) {
      rows.push('<div class="nfSelectMore muted">还有 ' + (options.length - shown.length) + ' 件，继续输入缩小范围</div>');
    }
    if (options.length > 6) {
      rows.push('<div class="nfSelectMore muted">共 ' + options.length + ' 件匹配 · 上面可滚动</div>');
    }
  }
  list.innerHTML = rows.length ? rows.join('') : '<div class="nfSelectEmpty muted">没有匹配</div>';
}

/** 前缀 > 完全相等 > 包含；同档按名字排。 */
function rankByQuery(list, q) {
  if (!q) { return list; }
  var lower = String(q).toLowerCase();
  var score = function (name) {
    var text = String(name || '').toLowerCase();
    if (text === lower) { return 0; }
    if (text.indexOf(lower) === 0) { return 1; }
    return 2;
  };
  return list.slice().sort(function (a, b) {
    var diff = score(a.n) - score(b.n);
    return diff !== 0 ? diff : String(a.n).localeCompare(String(b.n));
  });
}

function itemHtml(typeID, name, meta, unusable) {
  return '<div class="nfSelectItem" onmousedown="pickSelectItem(this, ' + typeID + ')" data-name="' + name + '">'
    + '<span class="nfSelectName">' + name + '</span>'
    + (meta ? '<span class="nfSelectMeta muted">' + meta + '</span>' : '')
    + '</div>';
}

function pickSelectItem(item, typeID) {
  var holder = item.closest('.nfSelect');
  var id = Number(typeID) || 0;
  var name = item.getAttribute('data-name') || '';
  closeAllSelects();
  if (!holder) { return; }
  if (holder.id === 'fitHullSelect') {
    setHullLabel(id ? name : '选择船体…');
    setFitHull(id);
    return;
  }
  var card = holder.closest('.fitSlotCard');
  var flag = Number(card.getAttribute('data-flag')) || 0;
  if (holder.hasAttribute('data-charge')) {
    fitSelectCharge(flag, id);
    return;
  }
  pickModule(flag, id);
}

function setHullLabel(text) {
  var holder = document.getElementById('fitHullSelect');
  var value = holder && holder.querySelector('.nfSelectValue');
  if (value) { value.textContent = text; }
}

// ---- 目录 -----------------------------------------------------------------

function loadFitCatalog() {
  if (fitState.ships) { renderFitHulls(); return; }
  fetch('/api/fit/catalog').then(function (r) { return r.json(); }).then(function (res) {
    fitState.ships = (res && res.ships) || [];
    renderFitHulls();
  }).catch(function (e) { fitMsg('读目录失败：' + e); });
}

function renderFitHulls() {
  var holder = document.getElementById('fitHullSelect');
  var value = holder && holder.querySelector('.nfSelectValue');
  if (value && !fitState.hull) {
    value.textContent = '选择船体（' + (fitState.ships || []).length + ' 种）';
  }
}

function loadFitModules(family, force) {
  if (!force && fitState.modules[family]) { return Promise.resolve(fitState.modules[family]); }
  return fetch('/api/fit/catalog?family=' + encodeURIComponent(family) + '&t=' + Date.now())
    .then(function (r) { return r.json(); }).then(function (res) {
      var list = (res && res.modules) || [];
      fitState.modules[family] = list;
      fitState.loaded = fitState.loaded || {};
      fitState.loaded[family] = {count: list.length, total: Number(res && res.total) || list.length};
      // 旧后端会把每族截到 200 条：记下来，界面上直接说清楚缺东西。
      if (res && Number(res.total) > list.length) {
        fitState.truncated = '服务端只返回了 ' + list.length + '/' + res.total + ' 个' + family + '模块'
          + (res.version ? '（服务端 ' + res.version + '）' : '') + ' —— 重启游戏服务端后再刷新';
      }
      list.forEach(function (m) { fitState.byType[m.typeID] = m; });
      return list;
    });
}

/** 强制重新拉一遍模块列表（页面开着时服务端升级/索引重建后不用刷新整页）。 */
function reloadFitModules() {
  fitState.modules = {};
  fitState.loaded = {};
  fitState.truncated = null;
  fitState.byType = {};
  fitState.chargeCache = {};
  if (!fitState.hullRow) {
    loadFitCatalog();
    fitMsg('已重新加载目录');
    return;
  }
  var hull = fitState.hullRow;
  var needed = FIT_SECTIONS
    .filter(function (s) { return Number(hull[s.attr]) > 0; })
    .map(function (s) { return s.family; });
  Promise.all(needed.map(function (f) { return loadFitModules(f, true); })
    .concat([loadFitModules('drone', true)])).then(function () {
      populateFitDrones();
      renderFitSlots();
      fitChanged();
      fitMsg('已重新加载模块列表');
    }).catch(function (e) { fitMsg('重新加载失败：' + e); });
}

function setFitHull(typeID) {
  fitState.hull = Number(typeID) || 0;
  fitState.hullRow = (fitState.ships || []).find(function (h) { return Number(h.typeID) === fitState.hull; }) || null;
  fitState.selected = {};
  fitState.charges = {};
  fitState.clipboard = null;
  var box = document.getElementById('fitSlots');
  if (!fitState.hullRow) {
    if (box) { box.innerHTML = '<div class="muted">选一艘船体开始配装</div>'; }
    setHullLabel('选择船体…');
    fitChanged();
    return;
  }
  setHullLabel(fitState.hullRow.n);
  var needed = FIT_SECTIONS
    .filter(function (s) { return Number(fitState.hullRow[s.attr]) > 0; })
    .map(function (s) { return s.family; });
  Promise.all(needed.map(loadFitModules).concat([loadFitModules('drone')])).then(function () {
    populateFitDrones();
    renderFitSlots();
    fitChanged();
  });
}

// ---- 槽位卡片 -------------------------------------------------------------

function fitAllV() {
  var box = document.getElementById('fitAllV');
  return !box || box.checked;
}

/** 全 V 技能倍率：输出 ×1.25；需求 ×0.75；炮台/发射器再 ×0.75。 */
function fitScales() {
  var allV = fitAllV();
  return {
    allV: allV,
    output: allV ? 1.25 : 1,
    need: allV ? 0.75 : 1,
    weapon: allV ? 0.5625 : 1
  };
}

function moduleCpu(m, scales) {
  return (Number(m.cpu) || 0) * (m.w ? scales.weapon : scales.need);
}

function modulePg(m, scales) {
  return (Number(m.pg) || 0) * (m.w ? scales.weapon : scales.need);
}

function fitModuleUsage(excludeFlag) {
  var cpu = 0;
  var pg = 0;
  var scales = fitScales();
  Object.keys(fitState.selected).forEach(function (key) {
    if (String(key) === String(excludeFlag)) { return; }
    var chosen = fitState.selected[key];
    var entry = chosen && fitState.byType[chosen.typeID];
    if (entry) {
      cpu += moduleCpu(entry, scales);
      pg += modulePg(entry, scales);
    }
  });
  return {cpu: cpu, pg: pg};
}

function fitLimits() {
  var hull = fitState.hullRow || {};
  var scales = fitScales();
  return {
    cpu: Math.round((Number(hull.cpuOut) || 0) * scales.output),
    pg: Math.round((Number(hull.pgOut) || 0) * scales.output)
  };
}

function fitHardpointUsage(excludeFlag) {
  var used = {turret: 0, launcher: 0};
  Object.keys(fitState.selected).forEach(function (key) {
    if (String(key) === String(excludeFlag)) { return; }
    var chosen = fitState.selected[key];
    var entry = chosen && fitState.byType[chosen.typeID];
    if (!entry) { return; }
    if (entry.wt) { used.turret += 1; }
    if (entry.wl) { used.launcher += 1; }
  });
  return used;
}

function fitOptionsFor(section, flag, fittableOnly) {
  var hull = fitState.hullRow || {};
  var usage = fitModuleUsage(flag);
  var scales = fitScales();
  var limits = fitLimits();
  var cpuMax = limits.cpu;
  var pgMax = limits.pg;
  // 已经超了就别再按"剩余"过滤——否则整张表会空掉，连换掉超载模块都做不到。
  var overCpu = cpuMax > 0 && usage.cpu > cpuMax;
  var overPg = pgMax > 0 && usage.pg > pgMax;
  var list = (fitState.modules[section.family] || []).filter(function (m) {
    if (section.family === 'rig' && m.rs && hull.rs && Number(m.rs) !== Number(hull.rs)) { return false; }
    if (section.family === 'high') {
      var hardpoints = fitHardpointUsage(flag);
      var maxTurret = Number(hull.turret) || 0;
      var maxLauncher = Number(hull.launcher) || 0;
      if (m.wt && maxTurret > 0 && hardpoints.turret >= maxTurret) { return false; }
      if (m.wl && maxLauncher > 0 && hardpoints.launcher >= maxLauncher) { return false; }
    }
    if (fittableOnly) {
      if (overCpu || overPg) {
        // 退一步：只保证"这件本身"在船体上限之内，玩家还能挑一件换上去。
        if (cpuMax && moduleCpu(m, scales) > cpuMax) { return false; }
        if (pgMax && modulePg(m, scales) > pgMax) { return false; }
      } else {
        if (cpuMax && usage.cpu + moduleCpu(m, scales) > cpuMax) { return false; }
        if (pgMax && usage.pg + modulePg(m, scales) > pgMax) { return false; }
      }
    }
    return true;
  }).sort(function (a, b) { return String(a.n).localeCompare(String(b.n)); });
  // 当前装着的这件永远留在列表里（哪怕因为过滤被排除）。
  var chosen = fitState.selected[flag];
  if (chosen && chosen.typeID && !list.some(function (m) { return Number(m.typeID) === Number(chosen.typeID); })) {
    var entry = fitState.byType[chosen.typeID];
    if (entry) { list.unshift(entry); }
  }
  return list;
}

function fitSlotCard(section, flag, index) {
  var chosen = fitState.selected[flag] || {};
  var entry = chosen.typeID ? fitState.byType[chosen.typeID] : null;
  var label = entry ? entry.n : '（空）';
  var chargeHtml = '';
  if (entry) {
    var charges = fitState.chargeCache[entry.typeID] || [];
    if (charges.length) {
      var chargeTypeID = Number(fitState.charges[flag]) || 0;
      var chargeEntry = chargeTypeID ? (charges.find(function (c) { return Number(c.typeID) === chargeTypeID; }) || null) : null;
      chargeHtml = '<div class="nfSelect nfSelectSmall" data-charge="1">'
        + '<div class="nfSelectButton" onclick="toggleSelect(this)">'
        + '<span class="nfSelectValue">' + esc(chargeEntry ? chargeEntry.n : '（不装弹药）') + '</span><span class="nfCaret">▾</span>'
        + '</div>'
        + '<div class="nfSelectPanel" hidden>'
        + '<input class="nfSelectSearch" placeholder="搜索弹药…" autocomplete="off" oninput="filterSelect(this)" onkeydown="selectKey(event,this)">'
        + '<div class="nfSelectList"></div>'
        + '</div>'
        + '</div>';
    }
  }
  return '<div class="fitSlotCard" data-flag="' + flag + '" data-family="' + section.family + '">'
    + '<div class="fitSlotTitle">' + section.label + ' ' + (index + 1) + '</div>'
    + '<div class="nfSelect">'
    + '<div class="nfSelectButton" onclick="toggleSelect(this)">'
    + '<span class="nfSelectValue">' + esc(label) + '</span><span class="nfCaret">▾</span>'
    + '</div>'
    + '<div class="nfSelectPanel" hidden>'
    + '<input class="nfSelectSearch" placeholder="搜索装备…" autocomplete="off" oninput="filterSelect(this)" onkeydown="selectKey(event,this)">'
    + '<div class="nfSelectList"></div>'
    + '</div>'
    + '</div>'
    + '<div class="fitSlotMeta muted">' + (entry
      ? ('CPU ' + Math.round(moduleCpu(entry, fitScales())) + ' / PG ' + Math.round(modulePg(entry, fitScales())))
      : '未装')
    + ' · 可选 ' + fitOptionsFor(section, flag, onlyFittable()).length + ' 件</div>'
    + chargeHtml
    + '<div class="fitSlotOps">'
    + '<button type="button" onclick="fitCopySlot(' + flag + ')" title="复制这个槽位的装备（含弹药）">复制</button>'
    + '<button type="button" onclick="fitPasteSlot(' + flag + ')"' + (fitState.clipboard && fitState.clipboard.typeID ? '' : ' disabled')
    + ' title="把复制的内容粘到这个槽位">粘贴</button>'
    + '<button type="button" onclick="fitUnloadSlot(' + flag + ')"' + (entry ? '' : ' disabled')
    + ' title="卸载这个槽位的装备">卸载</button>'
    + '</div>'
    + '</div>';
}

function fitUnloadSlot(flag) {
  if (!fitState.selected[flag]) {
    fitMsg('这个槽位本来就是空的');
    return;
  }
  delete fitState.selected[flag];
  delete fitState.charges[flag];
  renderFitSlots();
  fitChanged();
  fitMsg('已卸载');
}

function fitCopySlot(flag) {
  var chosen = fitState.selected[flag];
  if (!chosen || !chosen.typeID) {
    fitMsg('这个槽位是空的，没有可复制的装备');
    return;
  }
  fitState.clipboard = {typeID: chosen.typeID, chargeTypeID: Number(fitState.charges[flag]) || 0};
  var entry = fitState.byType[chosen.typeID];
  fitMsg('已复制：' + (entry ? entry.n : chosen.typeID) + ' —— 到别的槽位点「粘贴」');
  renderFitSlots();
}

function fitPasteSlot(flag) {
  var clip = fitState.clipboard;
  if (!clip || !clip.typeID) {
    fitMsg('剪贴板是空的：先在一个槽位点「复制」');
    return;
  }
  var card = document.querySelector('.fitSlotCard[data-flag="' + flag + '"]');
  var family = card ? card.getAttribute('data-family') : '';
  var entry = fitState.byType[clip.typeID];
  if (!entry) {
    fitMsg('剪贴板里的装备不在索引里');
    return;
  }
  if (entry.f && family && entry.f !== family) {
    fitMsg('这个槽位是「' + family + '」，装不了「' + entry.n + '」');
    return;
  }
  if (family === 'rig' && entry.rs && fitState.hullRow && fitState.hullRow.rs
      && Number(entry.rs) !== Number(fitState.hullRow.rs)) {
    fitMsg('改装件尺寸不符，装不上');
    return;
  }
  fitState.selected[flag] = {typeID: clip.typeID};
  if (clip.chargeTypeID) {
    fitState.charges[flag] = clip.chargeTypeID;
  } else {
    delete fitState.charges[flag];
  }
  if (!fitState.chargeCache[clip.typeID]) {
    fetch('/api/fit/charges?moduleTypeID=' + clip.typeID).then(function (r) { return r.json(); }).then(function (res) {
      fitState.chargeCache[clip.typeID] = (res && res.charges) || [];
      renderFitSlots();
      fitChanged();
    }).catch(function () {
      fitState.chargeCache[clip.typeID] = [];
      renderFitSlots();
      fitChanged();
    });
  } else {
    renderFitSlots();
    fitChanged();
  }
  fitMsg('已粘贴：' + entry.n);
}

function pickModule(flag, typeID) {
  var id = Number(typeID) || 0;
  closeAllSelects();
  if (!id) {
    delete fitState.selected[flag];
    delete fitState.charges[flag];
    renderFitSlots();
    fitChanged();
    return;
  }
  fitState.selected[flag] = {typeID: id};
  delete fitState.charges[flag];
  if (!fitState.chargeCache[id]) {
    fetch('/api/fit/charges?moduleTypeID=' + id).then(function (r) { return r.json(); }).then(function (res) {
      fitState.chargeCache[id] = (res && res.charges) || [];
      renderFitSlots();
      fitChanged();
    }).catch(function () {
      fitState.chargeCache[id] = [];
      renderFitSlots();
      fitChanged();
    });
    return;
  }
  renderFitSlots();
  fitChanged();
}

function fitSelectCharge(flag, value) {
  var typeID = Number(value) || 0;
  if (typeID) { fitState.charges[flag] = typeID; } else { delete fitState.charges[flag]; }
  renderFitSlots();
  fitChanged();
}

function renderFitSlots() {
  var box = document.getElementById('fitSlots');
  var hull = fitState.hullRow;
  if (!box) { return; }
  if (!hull) {
    box.innerHTML = '<div class="muted">选一艘船体开始配装</div>';
    return;
  }
  var html = '';
  var total = 0;
  FIT_SECTIONS.forEach(function (section) {
    var count = Number(hull[section.attr]) || 0;
    if (!count) { return; }
    var headExtra = '';
    if (section.family === 'high') {
      var hpUsed = fitHardpointUsage(null);
      var hpTurretMax = Number((fitState.hullRow || {}).turret) || 0;
      var hpLauncherMax = Number((fitState.hullRow || {}).launcher) || 0;
      if (hpTurretMax || hpLauncherMax) {
        headExtra = ' <span class="muted">· 炮台 ' + hpUsed.turret + '/' + hpTurretMax
          + ' · 发射器 ' + hpUsed.launcher + '/' + hpLauncherMax + '</span>';
      }
    }
    html += '<div class="fitSection"><div class="fitSectionHead"><b>' + section.label + '</b>'
      + ' <span class="muted">' + count + ' 个</span>' + headExtra + '</div><div class="gridCards fitSlotGrid">';
    for (var i = 0; i < count; i += 1) {
      html += fitSlotCard(section, section.base + i, i);
      total += 1;
    }
    html += '</div></div>';
  });
  box.innerHTML = html || '<div class="muted">这艘船没有可装配的槽位</div>';
  var info = document.getElementById('fitFilterInfo');
  if (info) {
    var loaded = fitState.loaded || {};
    var parts = [];
    if (total) {
      parts.push('共 ' + total + ' 个槽位');
    }
    var loadedParts = ['high', 'med', 'low', 'rig', 'subsystem']
      .filter(function (f) { return loaded[f]; })
      .map(function (f) {
        var row = loaded[f];
        return (f === 'high' ? '高' : f === 'med' ? '中' : f === 'low' ? '低' : f === 'rig' ? '改装' : '子系统')
          + ' ' + row.count + (row.total > row.count ? '/' + row.total : '');
      });
    if (loadedParts.length) {
      parts.push('已加载模块：' + loadedParts.join(' '));
    }
    info.textContent = parts.join(' · ');
    info.className = fitState.truncated ? 'warn' : 'muted';
    if (fitState.truncated) {
      info.textContent += ' · ' + fitState.truncated;
    }
  }
}

function populateFitDrones() {
  var sel = document.getElementById('fitDrone');
  if (!sel) { return; }
  var drones = fitState.modules.drone || [];
  sel.innerHTML = '<option value="">（不带无人机）</option>' + drones.map(function (d) {
    return '<option value="' + d.typeID + '">' + esc(d.n) + '</option>';
  }).join('');
}

function collectFit() {
  var modules = [];
  Object.keys(fitState.selected).forEach(function (key) {
    var chosen = fitState.selected[key];
    if (!chosen || !chosen.typeID) { return; }
    var module = {flagID: Number(key), typeID: chosen.typeID};
    var charge = fitState.charges[key];
    if (charge) { module.chargeTypeID = charge; }
    modules.push(module);
  });
  var drones = [];
  var droneSel = document.getElementById('fitDrone');
  var droneQty = Number((document.getElementById('fitDroneQty') || {}).value) || 0;
  if (droneSel && Number(droneSel.value) && droneQty > 0) {
    drones.push({typeID: Number(droneSel.value), quantity: droneQty});
  }
  return {hullTypeID: fitState.hull, modules: modules, drones: drones, allV: fitAllV()};
}

function fitChanged() {
  var req = collectFit();
  if (!req.hullTypeID) {
    var sum = document.getElementById('fitSummary');
    if (sum) { sum.textContent = '选一艘船体开始配装'; }
    return;
  }
  fetch('/api/fit/quote', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(req)})
    .then(function (r) { return r.json(); })
    .then(function (q) {
      var sum = document.getElementById('fitSummary');
      if (!sum) { return; }
      var usage = q.usage || {};
      var limits = usage.limits || {};
      var parts = [];
      parts.push('CPU ' + Math.round(usage.cpu || 0) + '/' + (limits.cpu || 0));
      parts.push('PG ' + Math.round(usage.pg || 0) + '/' + (limits.pg || 0));
      parts.push('槽 高' + ((usage.slots && usage.slots.high) || 0) + '/' + (limits.high || 0)
        + ' 中' + ((usage.slots && usage.slots.med) || 0) + '/' + (limits.med || 0)
        + ' 低' + ((usage.slots && usage.slots.low) || 0) + '/' + (limits.low || 0)
        + ' 改装' + ((usage.slots && usage.slots.rig) || 0) + '/' + (limits.rig || 0));
      parts.push('合计 ' + fmtIsk(q.total));
      if (q.stats) {
        parts.push('DPS ' + (q.stats.dps || 0) + ' · EHP ' + (q.stats.ehp || 0));
      }
sum.textContent = (usage.allV ? '全 V · ' : '基础 · ') + parts.join(' · ')
        + (q.ok ? '' : ' · 问题：' + (q.problems || []).join('，'));
      sum.className = 'fitSummaryBar ' + (q.ok ? 'muted' : 'muted warn');
    }).catch(function (e) { fitMsg('报价失败：' + e); });
}

function fitOrder() {
  var req = collectFit();
  if (!req.hullTypeID) { fitMsg('先选船体'); return; }
  req.count = Number((document.getElementById('fitCount') || {}).value) || 1;
  fitMsg('订购中（80% 卖价）…');
  fetch('/api/fit/order', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(req)})
    .then(function (r) { return r.json(); }).then(function (res) {
      fitMsg(linesText(res).slice(0, 240));
      if (typeof loadStock === 'function') { loadStock(); }
    }).catch(function (e) { fitMsg('订购失败：' + e); });
}

function fitSaveBlueprint() {
  var req = collectFit();
  if (!req.hullTypeID) { fitMsg('先选船体'); return; }
  var id = prompt('蓝图 id（英文/数字/短横线）', 'fit-' + req.hullTypeID);
  if (!id) { return; }
  req.id = id;
  req.name = id;
  fetch('/api/fit/save', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(req)})
    .then(function (r) { return r.json(); }).then(function (res) {
      fitMsg(linesText(res).slice(0, 240));
    }).catch(function (e) { fitMsg('保存失败：' + e); });
}

function fitReset() {
  fitState.hull = 0;
  fitState.hullRow = null;
  fitState.selected = {};
  fitState.charges = {};
  var qty = document.getElementById('fitDroneQty');
  if (qty) { qty.value = '0'; }
  closeAllSelects();
  setHullLabel('选择船体…');
  renderFitSlots();
  fitChanged();
}

// 点空白处收起所有下拉面板（点在下拉框内部不收起）
document.addEventListener('mousedown', function (ev) {
  if (ev.target && ev.target.closest && ev.target.closest('.nfSelect')) { return; }
  closeAllSelects();
});
