import type { Persistence } from "./persistence.js";
import type { ContactProfile, PolicyActionType, PolicyRiskLevel } from "./types.js";

export type PolicyDecision =
  | {
      decision: "allow";
      riskLevel: PolicyRiskLevel;
      contact: ContactProfile;
      reason: string;
    }
  | {
      decision: "requires_confirmation";
      riskLevel: "high";
      contact: ContactProfile;
      reason: string;
    }
  | {
      decision: "block";
      riskLevel: "high";
      contact: ContactProfile | null;
      reason: string;
    }
  | {
      decision: "needs_contact_classification";
      riskLevel: "high";
      contactQuery: string;
      reason: string;
    };

export interface PolicyEngine {
  evaluateOutboundAction(params: { actionType: PolicyActionType; contactQuery: string }): PolicyDecision;
}

export function createPolicyEngine(persistence: Persistence): PolicyEngine {
  return {
    evaluateOutboundAction({ actionType, contactQuery }) {
      const contact = persistence.getContactByNameOrAlias(contactQuery);
      if (!contact) {
        return {
          decision: "needs_contact_classification",
          riskLevel: "high",
          contactQuery,
          reason: `No trusted contact record exists for ${contactQuery}.`
        };
      }

      switch (contact.contact.trustLevel) {
        case "trusted":
          return {
            decision: "allow",
            riskLevel: "low",
            contact,
            reason: `${contact.contact.canonicalName} is classified as trusted for ${actionType}.`
          };
        case "approval_required":
          return {
            decision: "requires_confirmation",
            riskLevel: "high",
            contact,
            reason: `${contact.contact.canonicalName} requires explicit approval before ${actionType}.`
          };
        case "untrusted":
          return {
            decision: "block",
            riskLevel: "high",
            contact,
            reason: `${contact.contact.canonicalName} is classified as untrusted and ${actionType} is blocked.`
          };
      }
    }
  };
}
