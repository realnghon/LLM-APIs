#!/usr/bin/env node

/**
 * 构建离线安装包
 * 
 * 该脚本会将项目及其所有依赖打包成 .tar.gz 文件，
 * 用于在无网络环境的机器上部署。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🚀 开始构建离线安装包...\n');

// 1. 检查 node_modules 是否存在
if (!fs.existsSync('node_modules')) {
  console.log('❌ 未找到 node_modules 目录');
  console.log('   请先执行: npm install --production\n');
  process.exit(1);
}

// 2. 检查是否安装了生产依赖
console.log('✓ 检查依赖安装状态...');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const requiredDeps = Object.keys(packageJson.dependencies || {});

let missingDeps = [];
for (const dep of requiredDeps) {
  const depPath = path.join('node_modules', dep);
  if (!fs.existsSync(depPath)) {
    missingDeps.push(dep);
  }
}

if (missingDeps.length > 0) {
  console.log('❌ 缺少以下依赖:');
  missingDeps.forEach(dep => console.log(`   - ${dep}`));
  console.log('\n   请执行: npm install --production\n');
  process.exit(1);
}

console.log('✓ 所有依赖已安装\n');

// 3. 生成文件名（包含版本号和时间戳）
const version = packageJson.version;
const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const filename = `llm-apis-v${version}-offline-${timestamp}.tar.gz`;

console.log('📦 打包文件...');
console.log(`   输出: ${filename}\n`);

// 4. 确定要打包的文件
const filesToPack = [
  'APIs.js',
  'package.json',
  'package-lock.json',
  'config',
  'public',
  'scripts',
  'src',
  'node_modules'
];

// 检查文件是否存在
const existingFiles = filesToPack.filter(file => {
  if (!fs.existsSync(file)) {
    console.log(`⚠️  跳过不存在的文件/目录: ${file}`);
    return false;
  }
  return true;
});

if (existingFiles.length === 0) {
  console.error('❌ 没有找到任何可打包的文件');
  process.exit(1);
}

// 5. 使用 tar 打包
try {
  // 删除旧文件
  if (fs.existsSync(filename)) {
    fs.unlinkSync(filename);
  }

  // 使用 tar 命令直接创建 .tar.gz 文件
  console.log('   正在压缩（这可能需要一些时间）...\n');
  
  execSync(`tar -czf "${filename}" ${existingFiles.join(' ')}`, {
    stdio: 'inherit',
    shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
  });

  // 获取文件大小
  const stats = fs.statSync(filename);
  const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

  console.log('\n✅ 离线安装包构建成功！\n');
  console.log(`📦 文件名: ${filename}`);
  console.log(`📊 大小: ${fileSizeMB} MB\n`);
  
  console.log('📋 下一步:');
  console.log(`   1. 将 ${filename} 复制到离线机器`);
  console.log('   2. 在离线机器上解压:');
  console.log(`      tar -xzf ${filename}`);
  console.log('   3. 进入目录: cd LLM-APIs');
  console.log('   4. 配置 config/admin.json');
  console.log('   5. 启动服务: npm start\n');

} catch (error) {
  console.error('❌ 打包失败:', error.message);
  console.error('\n详细信息:', error.stderr ? error.stderr.toString() : '');
  process.exit(1);
}
