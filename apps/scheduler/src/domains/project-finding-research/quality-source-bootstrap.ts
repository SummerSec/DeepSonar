import { installFindingQualitySourceCapture } from "./quality-source-capture.js";

/** Scheduler preload, invoked by Node --import before its application graph.
 * Node/runtime loader/preload and signed immutable deployment form the TCB;
 * this module cannot authenticate its own already-loaded source. Install the
 * capture after the runtime's source transformer and do not register later
 * source-transforming hooks. Missing observations remain a hard quality error.
 */
installFindingQualitySourceCapture();
