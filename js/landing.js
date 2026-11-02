

/* ============================================================
   PLANNR — landing.js
   Real Supabase authentication
   ============================================================ */

const SUPABASE_URL = "https://tlimbaewebfyibhxdcbk.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Wkqp70DOPk_vDZNChqLi_g_70dmrgay";

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);


/* ============================================================
   SIGN IN / CREATE ACCOUNT
   ============================================================ */

function setupSignIn() {
  const form = document.getElementById("signin-form");
  const signupButton = document.getElementById("signup-btn");

  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email =
      document.getElementById("signin-email").value.trim();

    const password =
      document.getElementById("signin-password").value;

    if (!email || !password) {
      alert("Please enter your email and password.");
      return;
    }

    const button = form.querySelector(".signin-btn");

    button.disabled = true;
    button.textContent = "Signing in...";

    try {
      const { error } =
        await supabaseClient.auth.signInWithPassword({
          email,
          password
        });

      if (error) {
        if (/confirm/i.test(error.message)) {
          alert("Please confirm your email first. Check your inbox (and spam) for the link.");
        } else {
          alert(error.message);
        }
        return;
      }

      window.location.href = "app.html";

    } catch (error) {
      console.error(error);
      alert("Something went wrong. Please try again.");

    } finally {
      button.disabled = false;
      button.textContent = "Sign in";
    }
  });


  /* ==========================================================
     CREATE ACCOUNT
     ========================================================== */

  if (signupButton) {

    signupButton.addEventListener("click", async () => {

      const email =
        document.getElementById("signin-email").value.trim();

      const password =
        document.getElementById("signin-password").value;

      if (!email || !password) {
        alert("Enter an email and password first.");
        return;
      }

      signupButton.disabled = true;
      signupButton.textContent = "Creating account...";

      try {

        const { data, error } =
           await supabaseClient.auth.signUp({
             email,
             password,
             options: {
               emailRedirectTo: `${window.location.origin}/app.html`
             }
           });

        if (error) {
           if (/confirm/i.test(error.message)) {
             alert("Please confirm your email first. Check your inbox (and spam) for the link.");
           } else {
             alert(error.message);
           }
           return;
        }

        if (data.session) {

          window.location.href = "app.html";

        } else {

          alert(
            "Account created! Check your email to confirm your account, then sign in."
          );

        }

      } catch (error) {

        console.error(error);

        alert(
          "Something went wrong creating your account."
        );

      } finally {

        signupButton.disabled = false;
        signupButton.textContent = "Create account";

      }

    });

  }
}

async function resendConfirmation(email) {
  const { error } = await supabaseClient.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: `${window.location.origin}/app.html` }
  });

  alert(error ? error.message : "Confirmation email sent.");
}

/* Start authentication */
setupSignIn();

function setupPasswordToggle() {
  const input = document.getElementById("signin-password");
  const toggle = document.getElementById("toggle-password");

  if (!input || !toggle) return;

  toggle.addEventListener("click", () => {
    const show = input.type === "password";

    input.type = show ? "text" : "password";
    toggle.textContent = show ? "Hide" : "Show";
    toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
    toggle.setAttribute("aria-pressed", String(show));

    input.focus();
  });
}

setupPasswordToggle();

const resendBtn = document.getElementById("resend-btn");

if (resendBtn) {
  resendBtn.addEventListener("click", async () => {
    const email = document.getElementById("signin-email").value.trim();

    if (!email) {
      alert("Enter your email above first.");
      return;
    }

    resendBtn.disabled = true;
    await resendConfirmation(email);

    // Brief cooldown so people don't spam the button
    setTimeout(() => {
      resendBtn.disabled = false;
    }, 30000);
  });
}

/* ============================================================
   HOMEPAGE DEMO ANIMATION
   ============================================================ */

function startHomepageDemo() {

  const promptElement =
    document.getElementById("landing-task-input");

  const calendar =
    document.getElementById("landing-calendar-preview");

  const getStarted =
    document.getElementById("get-started-btn");

  if (!promptElement || !calendar || !getStarted) {
    return;
  }

  const prompt =
    "I have a chemistry test Thursday. I need 2 hours to study.";

  let characterIndex = 0;

  promptElement.textContent = "";


  /* Get Started is visible immediately */
  getStarted.classList.add("is-visible");


  /* ==========================================================
     TYPE PROMPT
     ========================================================== */

  function typePrompt() {

    if (characterIndex < prompt.length) {

      promptElement.textContent +=
        prompt[characterIndex];

      characterIndex++;

      setTimeout(typePrompt, 42);

      return;
    }


    /* Show calendar after typing finishes */

    setTimeout(() => {

      calendar.classList.add("is-visible");

    }, 400);

  }


  /* Small delay before typing begins */

  setTimeout(typePrompt, 900);

}


/* Start homepage animation */
startHomepageDemo();


/* ============================================================
   GET STARTED → SIGN IN
   ============================================================ */

const getStartedButton =
  document.getElementById("get-started-btn");

const signInSection =
  document.getElementById("signin-section");


if (getStartedButton && signInSection) {

  getStartedButton.addEventListener(
    "click",
    () => {

      signInSection.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });

    }
  );

}
