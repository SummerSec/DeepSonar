<?php
// 演示漏洞 1：SQL 注入（演示仓库，故意写的漏洞，供 agent 审计）
$username = $_GET['username'];
$password = $_GET['password'];

// 直接拼接用户输入到 SQL
$query = "SELECT * FROM users WHERE username = '" . $username . "' AND password = '" . $password . "'";
$result = mysqli_query($conn, $query);

if (mysqli_num_rows($result) > 0) {
    echo "登录成功";
    session_start();
    $_SESSION['user'] = $username;
} else {
    echo "登录失败";
}
?>
