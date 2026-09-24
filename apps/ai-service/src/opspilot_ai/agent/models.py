"""Structured investigation output.

Critical application logic never reads free-form model text: the graph, the
API and the UI all consume these models, and anything that fails validation is
handled as an error rather than displayed (spec §17).
"""

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field


class SourceType(StrEnum):
    DOCUMENT = "document"
    INCIDENT = "incident"
    DEPLOYMENT = "deployment"
    LOG = "log"
    METRIC = "metric"
    SERVICE = "service"


class Evidence(BaseModel):
    """One fact the answer rests on, tied to something actually retrieved."""

    source_type: SourceType
    #: Ledger id: a tool call id or a retrieved chunk id from *this* run.
    source_id: str
    #: What this evidence shows, in the investigator's own words.
    explanation: str = Field(min_length=3, max_length=600)


class ProbableCause(BaseModel):
    description: str = Field(min_length=3, max_length=600)
    confidence: float = Field(ge=0.0, le=1.0)
    evidence_ids: list[str] = Field(default_factory=list)


class RecommendedAction(BaseModel):
    description: str = Field(min_length=3, max_length=400)
    urgency: Literal["now", "soon", "follow_up"] = "soon"
    rationale: str = Field(default="", max_length=400)


class ProposedAction(BaseModel):
    """A write the agent may not perform. A human approves it (ADR-007)."""

    action_type: Literal[
        "ROLLBACK_DEPLOYMENT",
        "RESTART_SERVICE",
        "ASSIGN_ENGINEER",
        "CHANGE_SEVERITY",
    ]
    arguments: dict[str, str] = Field(default_factory=dict)
    rationale: str = Field(min_length=3, max_length=600)
    evidence_ids: list[str] = Field(default_factory=list)


class Citation(BaseModel):
    source_id: str
    label: str
    source_type: SourceType


class InvestigationResult(BaseModel):
    summary: str = Field(min_length=10, max_length=2000)
    confidence: float = Field(ge=0.0, le=1.0)
    probable_causes: list[ProbableCause] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)
    proposed_actions: list[ProposedAction] = Field(default_factory=list)
    related_incident_ids: list[str] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)
    #: Sources the plan skipped or that failed. Stated so the answer never
    #: implies more was examined than actually was.
    not_inspected: list[str] = Field(default_factory=list)


class PlanStep(BaseModel):
    tool: str
    arguments: dict[str, str | int] = Field(default_factory=dict)
    reason: str = Field(default="", max_length=300)


class InvestigationPlan(BaseModel):
    """What the planner decided to look at, and why."""

    steps: list[PlanStep] = Field(default_factory=list, max_length=8)
    rationale: str = Field(default="", max_length=600)


class Hypothesis(BaseModel):
    statement: str
    supported_by: list[str] = Field(default_factory=list)
