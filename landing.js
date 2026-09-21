/* ============================================================
   PLANNR — landing.js
   Handles the marketing/landing page only (index.html): the
   demo sign-in redirect into app.html. The calendar preview
   graphic is a static SVG in index.html, and the "See how it
   works" button is a plain anchor link (#signin-section) —
   neither needs JavaScript.
   ============================================================ */

function setupSignIn() {
  const form = document.getElementById("signin-form");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    // Demo-only: no real auth yet. This is where a real backend
    // check would go before redirecting.
    window.location.href = "app.html";
  });
}

setupSignIn();
