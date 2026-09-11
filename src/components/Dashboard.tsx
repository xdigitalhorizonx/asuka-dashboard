"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { CRM_STAGES, type CrmStage, type Lead, type Reminder, type ReminderPriority } from "@/lib/types";
import { uid, useAsukaStore } from "@/lib/store";

type Tab = "overview" | "reminders" | "calendar" | "notes" | "files" | "crm";
type Store = ReturnType<typeof useAsukaStore>;
