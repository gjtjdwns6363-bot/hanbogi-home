// /r/<시군구>/ 목록: 카드는 HTML에 다 들어 있고, 여기서는 거르기·정렬·50건씩 보기·공유만 한다. 의존성 없음.
(function () {
  var $ = function (i) { return document.getElementById(i); };
  var ol = document.querySelector('ol.deals'), box = document.querySelector('.filters[data-js]');
  if (!ol || !box) return;
  box.hidden = false;
  var cards = [].slice.call(ol.children), order = cards.slice(), n = 50;
  var key = { p: function (li) { return -li.dataset.p; }, c: function (li) { return li.dataset.c === '' ? Infinity : -li.dataset.c; }, d: function (li) { return -li.dataset.d.replace(/-/g, ''); } };
  function inBand(ar, v) { // "lo-hi" = lo < 전용 <= hi, 끝에 i면 lo <= 전용 <= hi
    if (!v) return true;
    var m = v.match(/^([\d.]+)-([\d.]+)(i?)$/);
    return (m[3] ? ar >= +m[1] : ar > +m[1]) && ar <= +m[2];
  }
  function draw() {
    var um = $('um').value, bd = $('bd').value, nd = $('nd').checked, so = $('so').value, m = 0;
    var list = so ? cards.slice().sort(function (a, b) { return key[so](a) - key[so](b); }) : order;
    list.forEach(function (li) {
      var ok = (!um || li.dataset.u === um) && inBand(+li.dataset.ar, bd) && !(nd && li.dataset.g);
      if (ok) { m++; li.querySelector('.rank').textContent = m + '위'; }
      li.hidden = !ok || m > n;
      ol.appendChild(li);
    });
    $('more').hidden = m <= n;
  }
  function reset() { n = 50; draw(); }
  $('um').onchange = $('bd').onchange = $('so').onchange = $('nd').onchange = reset;
  $('more').onclick = function () { n += 50; draw(); };
  $('share').onclick = function () {
    var u = location.href;
    if (navigator.share) navigator.share({ title: document.title, url: u }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(u).then(function () { $('share').textContent = '✅ 링크를 복사했어요'; });
    else prompt('이 주소를 복사하세요', u);
  };
  draw();
})();
