import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config", () => ({
  config: {
    deepseekApiKey: "test-key",
    deepseekApiBaseUrl: "https://api.deepseek.test",
    deepseekTranslationModel: "deepseek-v4-flash",
    deepseekTranslationTimeoutMs: 1_000,
  },
}));

import {
  SKILL_TRANSLATION_SYSTEM_PROMPT,
  shouldPreserveChineseDescription,
  skillTranslationService,
} from "../src/services/skill-translation.service";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DeepSeek Skill 元数据翻译", () => {
  it("使用 Flash 非思考模式并返回中文展示信息", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            displayName: "代码审查助手",
            displayDescription: "审查代码变更并识别潜在问题。",
          }),
        },
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(skillTranslationService.translate({
      skillName: "code-review",
      skillDescription: "Review code changes and identify issues.",
    })).resolves.toEqual({
      displayName: "代码审查助手",
      displayDescription: "审查代码变更并识别潜在问题。",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 300,
    });
    const messages = body.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0]).toEqual({
      role: "system",
      content: SKILL_TRANSLATION_SYSTEM_PROMPT,
    });
    expect(messages[1]).toEqual({
      role: "user",
      content: JSON.stringify({
        skillName: "code-review",
        skillDescription: "Review code changes and identify issues.",
      }),
    });
  });

  it("提示词保护专业名词和 Kocotree 固定术语", () => {
    expect(SKILL_TRANSLATION_SYSTEM_PROMPT).toContain(
      "Kocotree Skill：作为完整产品术语保留",
    );
    expect(SKILL_TRANSLATION_SYSTEM_PROMPT).toContain(
      "不得翻译为“Kocotree 技能”",
    );
    expect(SKILL_TRANSLATION_SYSTEM_PROMPT).toContain(
      "框架、库、软件包和模型名称必须保留",
    );
    expect(SKILL_TRANSLATION_SYSTEM_PROMPT).toContain(
      "CLI 命令、命令参数、环境变量、文件名、扩展名、文件路径、URL 和版本号必须保持原样",
    );
    expect(SKILL_TRANSLATION_SYSTEM_PROMPT).toContain(
      "使用反引号包裹的任何内容必须逐字保留",
    );
    expect(SKILL_TRANSLATION_SYSTEM_PROMPT).toContain(
      "只有表示普通能力或技巧时才翻译为“技能”",
    );
    expect(SKILL_TRANSLATION_SYSTEM_PROMPT).toContain(
      "displayDescription 必须逐字复制原文，不得翻译、润色、缩写或改写",
    );
  });

  it("识别中文和包含专业名词的中文描述", () => {
    expect(shouldPreserveChineseDescription(
      "审查代码变更，识别正确性、安全性和可维护性问题。",
    )).toBe(true);
    expect(shouldPreserveChineseDescription(
      "使用 React 和 API 构建 UI。运行 `pnpm dev` 查看结果。",
    )).toBe(true);
    expect(shouldPreserveChineseDescription(
      "Review React code and identify API compatibility issues.",
    )).toBe(false);
  });

  it("中文描述直接保留原文，不采用模型改写结果", async () => {
    const originalDescription =
      "使用 React 和 API 构建 UI。运行 `pnpm dev` 查看结果。";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            displayName: "React 界面构建",
            displayDescription: "这段内容被模型重新润色了。",
          }),
        },
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(skillTranslationService.translate({
      skillName: "react-ui-builder",
      skillDescription: originalDescription,
    })).resolves.toEqual({
      displayName: "React 界面构建",
      displayDescription: originalDescription,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]?.content).toContain(
      "本次 skillDescription 已判定为中文：只生成 displayName",
    );
  });

  it("拒绝没有中文内容的模型响应", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            displayName: "Code Review",
            displayDescription: "Review code changes.",
          }),
        },
      }],
    }), { status: 200 })));

    await expect(skillTranslationService.translate({
      skillName: "code-review",
      skillDescription: "Review code changes.",
    })).rejects.toMatchObject({
      code: "INVALID_TRANSLATION_RESPONSE",
      statusCode: 502,
    });
  });
});
