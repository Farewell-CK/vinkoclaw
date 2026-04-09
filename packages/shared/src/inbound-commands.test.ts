import { describe, expect, it } from "vitest";
import { parseTemplateToggleCommand } from "./inbound-commands.js";

describe("parseTemplateToggleCommand", () => {
  it("parses disable template command in Chinese", () => {
    const parsed = parseTemplateToggleCommand("暂停模板 互联网产品全流程交付");
    expect(parsed).toEqual({
      action: "disable",
      templateQuery: "互联网产品全流程交付"
    });
  });

  it("parses enable template command in English", () => {
    const parsed = parseTemplateToggleCommand("enable template tpl-opc-internet-launch");
    expect(parsed).toEqual({
      action: "enable",
      templateQuery: "tpl-opc-internet-launch"
    });
  });

  it("returns undefined for non-template messages", () => {
    const parsed = parseTemplateToggleCommand("请安排前端和后端今天联调");
    expect(parsed).toBeUndefined();
  });
});
