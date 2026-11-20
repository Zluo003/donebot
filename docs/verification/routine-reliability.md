# 自动化可靠性

所有测试使用临时 home/data、合成 Bot 和 fake engine，不接触真实用户应用。

```sh
pnpm exec vitest run server/routine-reliability.test.ts server/routine-bounds.test.ts server/routine-file.test.ts server/routine-run-gate.test.ts server/routine-health.test.ts server/routine-no-start.test.ts server/routine-skips.test.ts server/routines.test.ts
pnpm exec vitest run server/routine-file-recovery.e2e.test.ts server/routine-continuity.e2e.test.ts server/routine-recovery.e2e.test.ts server/routine-results.e2e.test.ts server/automations-lifecycle.e2e.test.ts server/webhook-continuity.e2e.test.ts
```

第一组验证时钟跳变、睡眠、工作时限、忙等、漏跑合并、失败退避、停止确认及保存失败回滚。暂停或删除等待中的运行会结束其轮次，用户后来在同一会话启动的新轮次保留；准备检查异常时不得执行，撤销时晚到的结果失效。

第二组启动真正的隔离服务。损坏文件流程先创建停用的测试任务，停止服务并破坏 routines.json，重新启动后验证配置告警、写入拒绝、原字节保留和 0600 副本。修复后等真实调度器重新读取，再手动运行一次；再次重启确认无重复运行，日志不含秘密测试哨兵。证据保存至 fixture.logPath 旁的 `.routine-file.json`，临时 home 最终删除。

这些结果不替代真实 Linux 资源压力、跨设备执行、实际云桌面就绪或平台升级验收。
