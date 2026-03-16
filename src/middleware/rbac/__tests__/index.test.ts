import { describe, it, expect } from "vitest";
import { checkPermission } from "../index.js";
import { RbacRejectionError } from "../errors.js";

describe("checkPermission", () => {
  const userId = "user-123";
  const action = "create_ticket";
  const requiredRole = "Project Manager";

  it("does NOT throw when userRoles includes the requiredRole", () => {
    expect(() =>
      checkPermission(userId, action, requiredRole, ["Developer", "Project Manager"])
    ).not.toThrow();
  });

  it("does NOT throw when userRoles contains exactly the requiredRole", () => {
    expect(() =>
      checkPermission(userId, action, requiredRole, [requiredRole])
    ).not.toThrow();
  });

  it("throws RbacRejectionError when userRoles does NOT include requiredRole", () => {
    expect(() =>
      checkPermission(userId, action, requiredRole, ["Developer", "Tester"])
    ).toThrow(RbacRejectionError);
  });

  it("throws RbacRejectionError when userRoles is empty", () => {
    expect(() =>
      checkPermission(userId, action, requiredRole, [])
    ).toThrow(RbacRejectionError);
  });

  describe("thrown RbacRejectionError properties", () => {
    let thrownError: RbacRejectionError;

    beforeEach(() => {
      try {
        checkPermission(userId, action, requiredRole, ["Developer"]);
      } catch (err) {
        thrownError = err as RbacRejectionError;
      }
    });

    it("has blockedAction set to the action string", () => {
      expect(thrownError.blockedAction).toBe(action);
    });

    it("has requiredRole set to the required role string", () => {
      expect(thrownError.requiredRole).toBe(requiredRole);
    });

    it("plainLanguageMessage starts with 'Blocked: Insufficient Privileges'", () => {
      expect(thrownError.plainLanguageMessage).toContain("Blocked: Insufficient Privileges");
    });

    it("plainLanguageMessage does not use apologetic phrasing", () => {
      expect(thrownError.plainLanguageMessage).not.toMatch(/I'm sorry|I apologize|don't have permission|Unfortunately/i);
    });

    it("plainLanguageMessage contains the requiredRole", () => {
      expect(thrownError.plainLanguageMessage).toContain(requiredRole);
    });

    it("plainLanguageMessage contains 'workspace administrator'", () => {
      expect(thrownError.plainLanguageMessage).toContain("workspace administrator");
    });

    it("plainLanguageMessage does NOT contain the userId", () => {
      expect(thrownError.plainLanguageMessage).not.toContain(userId);
    });

    it("plainLanguageMessage does NOT contain '@'", () => {
      expect(thrownError.plainLanguageMessage).not.toContain("@");
    });

    it("error name is RbacRejectionError", () => {
      expect(thrownError.name).toBe("RbacRejectionError");
    });
  });
});
