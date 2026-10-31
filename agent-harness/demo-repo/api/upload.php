<?php
// 演示漏洞 2：任意文件上传 + 路径穿越（演示仓库，故意写的漏洞）
$target_dir = "uploads/";
$filename = $_FILES["file"]["name"];

// 未校验扩展名、未过滤路径分隔符
$target_file = $target_dir . $filename;

if (move_uploaded_file($_FILES["file"]["tmp_name"], $target_file)) {
    echo "上传成功: " . $target_file;
}

// 演示漏洞 3：硬编码密钥
$aws_secret = "AKIAIOSFODNN7EXAMPLE";
$db_pass = "root123456";
?>
