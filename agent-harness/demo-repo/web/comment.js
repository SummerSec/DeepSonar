// 演示漏洞 4：XSS + 危险 eval（演示仓库，故意写的漏洞）
function renderComment() {
  const params = new URLSearchParams(window.location.search);
  const comment = params.get("c");
  // 直接插入 DOM，未转义
  document.getElementById("comment").innerHTML = comment;
}

function runTemplate(tpl) {
  // 用户可控输入进 eval
  return eval(tpl);
}

module.exports = { renderComment, runTemplate };
