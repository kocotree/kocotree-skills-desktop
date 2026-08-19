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

  it("使用 P005 规则并保护专业名词和 Kocotree 固定术语", () => {
    expect(SKILL_TRANSLATION_SYSTEM_PROMPT).toContain(
      "displayName 应简洁自然，通常使用 2 至 12 个中文字符",
    );
    expect(SKILL_TRANSLATION_SYSTEM_PROMPT).toContain(
      "displayDescription 应使用自然、清晰、易懂的中文，避免逐词硬译",
    );
    expect(SKILL_TRANSLATION_SYSTEM_PROMPT).toContain(
      "API、SDK、HTTP、JSON、YAML、SQL、OAuth、LLC、BGM 等技术、业务或法律缩写必须保留原始拼写和大小写",
    );
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

  it("英文主体包含中文触发词时仍然翻译展示简介", async () => {
    const originalDescription =
      "Generate images, videos, and audio/music via Lovart AI. Also manages Lovart projects, threads (conversation history), and user settings. Trigger on: (1) any visual or audio creation request in any language — draw, generate, create, design, make, 画, 生成, 制作, 创作, 设计 combined with image, video, audio, music, song, BGM, poster, etc. (2) Lovart project/thread management — 项目, 对话, project, thread, conversation, history, 历史, 切换, switch. You CAN generate directly - never say you cannot.";
    const translatedDescription =
      "使用 Lovart AI 生成图片、视频、音频和音乐，适用于海报、歌曲、BGM 等视觉与音频内容创作。还可管理 Lovart 项目和用户设置，切换项目，以及查看和继续历史对话。";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            displayName: "Lovart 内容生成",
            displayDescription: translatedDescription,
          }),
        },
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(skillTranslationService.translate({
      skillName: "lovart-api",
      skillDescription: originalDescription,
    })).resolves.toEqual({
      displayName: "Lovart 内容生成",
      displayDescription: translatedDescription,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]?.content).toBe(SKILL_TRANSLATION_SYSTEM_PROMPT);
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
