"""Output guardrails.

The model is treated as an untrusted component: whatever it returns is checked
against the ledger before anyone sees it. Retrieved documents are likewise data,
never instructions (spec §21).
"""

from opspilot_ai.logging import get_logger

from .ledger import Ledger
from .models import Evidence, InvestigationResult, ProbableCause

logger = get_logger(__name__)

#: Wrapper for anything that came from a document or a tool. The system prompt
#: states that text inside it is evidence to weigh, never instructions to obey.
UNTRUSTED_OPEN = "<untrusted_data>"
UNTRUSTED_CLOSE = "</untrusted_data>"


def wrap_untrusted(text: str) -> str:
    # Strip any attempt to close the block early and smuggle in instructions.
    cleaned = text.replace(UNTRUSTED_OPEN, "").replace(UNTRUSTED_CLOSE, "")
    return f"{UNTRUSTED_OPEN}\n{cleaned}\n{UNTRUSTED_CLOSE}"


def enforce_provenance(
    result: InvestigationResult, ledger: Ledger
) -> tuple[InvestigationResult, list[str]]:
    """Removes anything the run cannot support, and says what was removed.

    A fabricated citation is not an error to apologise for: it is simply
    deleted, and the confidence is reduced to match what is left.
    """
    known = ledger.known_ids()
    removed: list[str] = []

    evidence: list[Evidence] = []
    for item in result.evidence:
        if item.source_id in known:
            evidence.append(item)
        else:
            removed.append(f"evidence:{item.source_id}")

    surviving_evidence_ids = {item.source_id for item in evidence}

    causes: list[ProbableCause] = []
    for cause in result.probable_causes:
        supported = [ref for ref in cause.evidence_ids if ref in surviving_evidence_ids]
        dropped = set(cause.evidence_ids) - set(supported)
        removed.extend(f"cause-evidence:{ref}" for ref in dropped)
        causes.append(cause.model_copy(update={"evidence_ids": supported}))

    citations = ledger.citations([item.source_id for item in evidence])

    proposals = []
    for proposal in result.proposed_actions:
        supported = [ref for ref in proposal.evidence_ids if ref in surviving_evidence_ids]
        if not supported:
            # An action nobody can trace to evidence is not offered at all.
            removed.append(f"proposal:{proposal.action_type}")
            continue
        proposals.append(proposal.model_copy(update={"evidence_ids": supported}))

    confidence = result.confidence
    if removed:
        logger.warning("provenance_violations", count=len(removed), removed=removed[:10])
        # Confidence claimed on the strength of invented support is not earned.
        confidence = min(confidence, 0.5)
    if not evidence:
        confidence = min(confidence, 0.2)

    not_inspected = list(
        dict.fromkeys(
            [
                *result.not_inspected,
                *(f"{tool} (failed)" for tool in ledger.failed_tools()),
                *(f"{tool} (no results)" for tool in ledger.empty_tools()),
            ]
        )
    )

    cleaned = result.model_copy(
        update={
            "evidence": evidence,
            "probable_causes": causes,
            "citations": citations,
            "proposed_actions": proposals,
            "confidence": round(confidence, 2),
            "not_inspected": not_inspected,
        }
    )
    return cleaned, removed
