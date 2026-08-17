import { config } from "../config";

export interface SkillMetadataTranslation {
  displayName: string;
  displayDescription: string;
}

export class SkillTranslationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillTranslationError";
  }
}

interface DeepSeekResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

export const SKILL_TRANSLATION_SYSTEM_PROMPT = [
  "你是软件 Skill 元数据的中文本地化编辑。",
  "请根据原始 skillName 和 skillDescription，生成面向中文普通用户的展示名称和展示简介。",
  "翻译规则：",
  "1. 忠实表达原文，不增加原文没有的功能、能力、承诺或使用场景。",
  "2. displayName 应简洁自然，通常使用 2 至 12 个中文字符；包含必要专业名词时允许中英混排，但必须同时包含能说明用途的中文词。",
  "3. displayDescription 应使用自然、清晰、易懂的中文，避免逐词硬译。",
  "4. 品牌、公司、产品、项目、编程语言、框架、库、软件包和模型名称必须保留，不得翻译、音译或改写。",
  "5. API、SDK、HTTP、JSON、YAML、SQL、OAuth 等技术缩写必须保留原始拼写和大小写。",
  "6. 函数名、类名、变量名、参数名、CLI 命令、命令参数、环境变量、文件名、扩展名、文件路径、URL 和版本号必须保持原样。",
  "7. 使用反引号包裹的任何内容必须逐字保留。",
  "8. 通用功能词应翻译成中文，例如 review 翻译为“审查”、deployment 翻译为“部署”、debugging 翻译为“调试”。",
  "9. 不要擅自添加“智能”“高级”“自动化”“专业”等宣传性词语；只有原文明确表达 assistant、helper 等含义时才使用“助手”。",
  "固定产品术语：",
  "- Kocotree：品牌名，不得翻译或音译；大小写不同的写法统一规范为 Kocotree。",
  "- Kocotree Skill：作为完整产品术语保留，不得翻译为“Kocotree 技能”。",
  "- Skill：当它表示 Kocotree 中可安装、上传、发布或管理的对象时保留英文；只有表示普通能力或技巧时才翻译为“技能”。",
  "- 包含 Kocotree、Kocotree Skill 或其他不可翻译术语的 displayName，应组合简短的中文用途说明，例如“Kocotree Skill 管理”“GitHub PR 审查”“React 性能优化”。",
  "如果原始描述已经是中文，displayDescription 必须逐字复制原文，不得翻译、润色、缩写或改写。",
  "只返回 JSON 对象，字段必须且只能是 displayName 和 displayDescription；不要返回解释、Markdown 或代码块。",
].join("\n");

export function shouldPreserveChineseDescription(text: string): boolean {
  const naturalLanguageText = text
    .replace(/`[^`]*`/gu, " ")
    .replace(/https?:\/\/\S+/giu, " ");
  const chineseCharacterCount = naturalLanguageText.match(
    /\p{Script=Han}/gu,
  )?.length ?? 0;
  const latinWordCount = naturalLanguageText.match(/[A-Za-z]+/g)?.length ?? 0;
  const hasChinesePunctuation = /[，。！？；：]/u.test(naturalLanguageText);
  return chineseCharacterCount >= 8 || (
    chineseCharacterCount >= 4 && (
      hasChinesePunctuation ||
      chineseCharacterCount >= Math.max(2, latinWordCount * 2)
    )
  );
}

function readTranslation(
  content: string,
  preservedDescription?: string,
): SkillMetadataTranslation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new SkillTranslationError(
      502,
      "INVALID_TRANSLATION_RESPONSE",
      "AI 翻译结果格式无效，请重试",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SkillTranslationError(
      502,
      "INVALID_TRANSLATION_RESPONSE",
      "AI 翻译结果格式无效，请重试",
    );
  }
  const record = parsed as Record<string, unknown>;
  const displayName = typeof record.displayName === "string"
    ? record.displayName.trim()
    : "";
  const displayDescription = preservedDescription ?? (
    typeof record.displayDescription === "string"
      ? record.displayDescription.trim()
      : ""
  );
  const containsChinese = /\p{Script=Han}/u;
  if (
    !displayName ||
    displayName.length > 100 ||
    !containsChinese.test(displayName) ||
    !displayDescription ||
    displayDescription.length > 1_000 ||
    !containsChinese.test(displayDescription)
  ) {
    throw new SkillTranslationError(
      502,
      "INVALID_TRANSLATION_RESPONSE",
      "AI 未返回有效的中文展示信息，请重试",
    );
  }
  return { displayName, displayDescription };
}

export const skillTranslationService = {
  async translate(input: {
    skillName: string;
    skillDescription: string;
  }): Promise<SkillMetadataTranslation> {
    if (!config.deepseekApiKey) {
      throw new SkillTranslationError(
        503,
        "TRANSLATION_UNAVAILABLE",
        "AI 翻译服务尚未配置",
      );
    }

    const preserveChineseDescription = shouldPreserveChineseDescription(
      input.skillDescription,
    );
    const systemPrompt = preserveChineseDescription
      ? [
          SKILL_TRANSLATION_SYSTEM_PROMPT,
          "本次 skillDescription 已判定为中文：只生成 displayName；displayDescription 必须逐字复制用户提供的 skillDescription。",
        ].join("\n")
      : SKILL_TRANSLATION_SYSTEM_PROMPT;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.deepseekTranslationTimeoutMs,
    );
    let response: Response;
    try {
      response = await fetch(
        `${config.deepseekApiBaseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.deepseekApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.deepseekTranslationModel,
            thinking: { type: "disabled" },
            response_format: { type: "json_object" },
            temperature: 0.2,
            max_tokens: 300,
            messages: [
              {
                role: "system",
                content: systemPrompt,
              },
              {
                role: "user",
                content: JSON.stringify(input),
              },
            ],
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new SkillTranslationError(
          504,
          "TRANSLATION_TIMEOUT",
          "AI 翻译超时，请重试",
        );
      }
      throw new SkillTranslationError(
        503,
        "TRANSLATION_UNAVAILABLE",
        "AI 翻译服务暂时不可用，请重试",
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new SkillTranslationError(
        502,
        "TRANSLATION_PROVIDER_ERROR",
        "AI 翻译服务返回异常，请重试",
      );
    }

    const payload = await response.json().catch(() => null) as DeepSeekResponse | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
      throw new SkillTranslationError(
        502,
        "INVALID_TRANSLATION_RESPONSE",
        "AI 翻译结果为空，请重试",
      );
    }
    return readTranslation(
      content,
      preserveChineseDescription ? input.skillDescription : undefined,
    );
  },
};
