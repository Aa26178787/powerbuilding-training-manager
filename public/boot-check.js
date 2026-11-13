// 앱 JS가 뜨지 못했을 때(옛 캐시, 파일 누락, 시작 오류) 검은 화면 대신 안내와 복구 버튼을 보여 준다.
// 훈련 기록(IndexedDB)은 건드리지 않는다. 지우는 것은 앱 파일 캐시와 Service Worker뿐이다.
(function () {
  var shown = false;
  function show(detail) {
    var root = document.getElementById('root');
    if (shown || !root || root.childElementCount > 0) return;
    shown = true;
    var box = document.createElement('div');
    box.setAttribute('style', 'padding:24px;color:#eeece7;font:15px/1.5 system-ui,sans-serif;max-width:480px;margin:0 auto');
    box.innerHTML = '<p style="font-weight:700;font-size:17px;margin:0 0 6px">화면을 불러오지 못했습니다</p>' +
      '<p style="margin:0 0 14px;color:#9a9fa8">훈련 기록은 이 기기에 그대로 있습니다. 앱 파일만 새로 받으면 대부분 해결됩니다.</p>' +
      '<button id="ptm-fix" style="width:100%;height:48px;border:0;border-radius:12px;background:#eeece7;color:#141518;font-weight:700;font-size:15px">앱 파일 새로 받기</button>' +
      '<button id="ptm-reload" style="width:100%;height:44px;margin-top:8px;border:1px solid #2e3137;border-radius:12px;background:none;color:#eeece7;font-size:14px">그냥 다시 열기</button>' +
      '<pre id="ptm-detail" style="white-space:pre-wrap;word-break:break-all;margin-top:14px;font-size:12px;color:#9a9fa8"></pre>';
    root.appendChild(box);
    document.getElementById('ptm-detail').textContent = detail || '';
    document.getElementById('ptm-reload').onclick = function () { location.reload(); };
    document.getElementById('ptm-fix').onclick = function () {
      var jobs = [];
      if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); }));
      if (window.caches) jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }));
      Promise.all(jobs).catch(function () {}).then(function () { location.reload(); });
    };
  }
  window.__ptmShowBootError = show;
  // 스크립트·스타일 파일을 못 받은 경우(404 등)
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'SCRIPT' || (t.tagName === 'LINK' && t.rel === 'stylesheet'))) show('파일을 받지 못했습니다: ' + (t.src || t.href));
  }, true);
  // 그 밖에 아무것도 그려지지 않은 채 시간이 지난 경우
  setTimeout(function () { show('시작이 10초 넘게 끝나지 않았습니다.'); }, 10000);
})();
