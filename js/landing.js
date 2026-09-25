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

function setupSignIn() {
  const form = document.getElementById("signin-form");
  const signupButton = document.getElementById("signup-btn");

  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = document.getElementById("signin-email").value.trim();
    const password = document.getElementById("signin-password").value;

    if (!email || !password) {
      alert("Please enter your email and password.");
      return;
    }

    const button = form.querySelector(".signin-btn");
    button.disabled = true;
    button.textContent = "Signing in...";

    try {
      const { error } = await supabaseClient.auth.signInWithPassword({
        email,
        password
      });

      if (error) {
        alert(error.message);
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

  if (signupButton) {
    signupButton.addEventListener("click", async () => {
      const email = document.getElementById("signin-email").value.trim();
      const password = document.getElementById("signin-password").value;

      if (!email || !password) {
        alert("Enter an email and password first.");
        return;
      }

      signupButton.disabled = true;
      signupButton.textContent = "Creating account...";

      try {
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password
        });

        if (error) {
          alert(error.message);
          return;
        }

        if (data.session) {
          window.location.href = "app.html";
        } else {
          alert("Account created! Check your email to confirm your account, then sign in.");
        }

      } catch (error) {
        console.error(error);
        alert("Something went wrong creating your account.");

      } finally {
        signupButton.disabled = false;
        signupButton.textContent = "Create account";
      }
    });
  }
}

setupSignIn();
