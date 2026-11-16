/* Runs ahead of every bundle (scripts/build.mjs puts it in as an esbuild banner). Gecko 84 lacks these, and dependencies call them while their modules load; esbuild lowers syntax but not missing built-ins. The directive must stay first, or the bundle's own "use strict" after this banner stops applying. */
'use strict';
if (!Object.hasOwn) Object.hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
