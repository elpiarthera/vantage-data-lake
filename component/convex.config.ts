import { defineComponent } from "convex/server";
import rag from "@convex-dev/rag/convex.config.js";

const component = defineComponent("dataLake");
component.use(rag);

export default component;
