import { Job } from "../types/job";

export const initialJobs: Job[] = [
  {
    id: "1",
    customer: "Müller GmbH",
    location: "Lüdenscheid",
    time: "08:00",
    service: "Office Cleaning",
    employee: "Ali",
    status: "open",
  },
  {
    id: "2",
    customer: "Spark Center",
    location: "Dortmund",
    time: "10:30",
    service: "Window Cleaning",
    employee: "Sara",
    status: "in_progress",
  },
  {
    id: "3",
    customer: "TechPoint",
    location: "Hagen",
    time: "13:00",
    service: "Deep Cleaning",
    employee: "Feras",
    status: "completed",
  },
  {
    id: "4",
    customer: "Nord Office",
    location: "Iserlohn",
    time: "15:00",
    service: "Floor Cleaning",
    employee: "Maya",
    status: "open",
  },
];