#!/bin/bash
set -e
echo "=== 1. Git 提交 ==="
git add -A
git commit -m "deploy: $(date +'%Y-%m-%d %H:%M')" || echo "无新变更"
echo "=== 2. 推送到 GitHub ==="
git push origin main
echo "=== 3. Vercel 生产部署 ==="
vercel --prod -y
echo "=== 部署完成: https://keyclaw.tech ==="
