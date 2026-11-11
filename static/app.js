document.querySelectorAll('[data-slot]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-slot]').forEach(other => {
      other.classList.remove('selected');
      other.setAttribute('aria-pressed', 'false');
    });
    button.classList.add('selected');
    button.setAttribute('aria-pressed', 'true');
    document.getElementById('selection').textContent = button.dataset.label;
    document.getElementById('booking-form').action = `/slots/${button.dataset.slot}/book`;
    document.getElementById('book-button').disabled = false;
  });
});
document.getElementById('booking-form')?.addEventListener('submit', event => {
  const form = event.target;
  if (!form.email.value.trim() && !form.phone.value.trim()) {
    event.preventDefault();
    form.email.setCustomValidity('Enter an email address or phone number.');
    form.email.reportValidity();
    return;
  }
  document.getElementById('book-button').disabled = true;
  document.getElementById('book-button').textContent = 'Saving your appointment…';
});
['email', 'phone'].forEach(name => document.querySelector(`[name="${name}"]`)?.addEventListener('input', () => {
  document.querySelector('[name="email"]').setCustomValidity('');
}));
