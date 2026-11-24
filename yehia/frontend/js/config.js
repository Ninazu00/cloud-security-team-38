(function () {
  "use strict";

  const isLocalDev = window.location.port === "8080";
  const LOCAL_API_URL = "http://localhost:3002";
  const FLOCI_API_URL = "http://56740348ff.execute-api.localhost.floci.io:4566";

  window.APP_CONFIG = Object.freeze({
    API_BASE_URL: isLocalDev ? LOCAL_API_URL : FLOCI_API_URL,
    ENV_LABEL: isLocalDev ? "Local Express (:3002)" : "Floci API Gateway (:4566)",
    MOCK_COURSES: [
      { id: "1", label: "CS401 - Cloud Computing", note: "Valid with 2 & 3" },
      { id: "2", label: "CS402 - Cloud Security", note: "Valid with 1 & 3" },
      { id: "3", label: "CS403 - Distributed Systems", note: "Valid with 1 & 2" },
      { id: "4", label: "Course 4", note: "Clashes with CS401" }
    ]
  });
})();
