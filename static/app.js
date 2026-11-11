const workspace = document.querySelector('.booking-workspace');
const form = document.getElementById('booking-form');
const steps = [...document.querySelectorAll('[data-step]')];
function setStage(stage) {
  workspace.dataset.stage = stage;
  steps.forEach(button => {
    button.classList.toggle('active', button.dataset.step === stage);
    if (button.dataset.step === stage) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });
}
steps.forEach(button => button.addEventListener('click', () => setStage(button.dataset.step)));
document.querySelectorAll('[data-date]:not(:disabled)').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-date]').forEach(other => {
      other.classList.toggle('selected', other === button);
      other.setAttribute('aria-pressed', String(other === button));
    });
    document.querySelectorAll('[data-times-for]').forEach(group => {
      group.hidden = group.dataset.timesFor !== button.dataset.date;
    });
    document.querySelectorAll('[data-slot]').forEach(other => {
      other.classList.remove('selected');
      other.setAttribute('aria-pressed', 'false');
    });
    document.getElementById('chosen-date').textContent = button.dataset.dateLabel;
    document.getElementById('time-placeholder').hidden = true;
    document.getElementById('details-placeholder').hidden = false;
    document.getElementById('selection').textContent = 'Choose a time to continue.';
    document.getElementById('book-button').disabled = true;
    form.hidden = true;
    form.removeAttribute('action');
    steps.find(step => step.dataset.step === 'time').disabled = false;
    steps.find(step => step.dataset.step === 'details').disabled = true;
    setStage('time');
    document.querySelector(`[data-times-for="${button.dataset.date}"] button`)?.focus({preventScroll: true});
  });
});
document.querySelectorAll('[data-slot]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-slot]').forEach(other => {
      other.classList.toggle('selected', other === button);
      other.setAttribute('aria-pressed', String(other === button));
    });
    document.getElementById('selection').textContent = button.dataset.label;
    form.action = `/slots/${button.dataset.slot}/book`;
    form.hidden = false;
    document.getElementById('details-placeholder').hidden = true;
    document.getElementById('book-button').disabled = false;
    steps.find(step => step.dataset.step === 'details').disabled = false;
    setStage('details');
  });
});
let monthIndex = 0;
const months = [...document.querySelectorAll('[data-month]')];
function changeMonth(delta) {
  monthIndex = Math.max(0, Math.min(months.length - 1, monthIndex + delta));
  months.forEach((month, index) => { month.hidden = index !== monthIndex; });
  document.getElementById('month-label').textContent = months[monthIndex].dataset.monthLabel;
  document.getElementById('previous-month').disabled = monthIndex === 0;
  document.getElementById('next-month').disabled = monthIndex === months.length - 1;
}
document.getElementById('previous-month')?.addEventListener('click', () => changeMonth(-1));
document.getElementById('next-month')?.addEventListener('click', () => changeMonth(1));
form?.addEventListener('submit', event => {
  if (!form.getAttribute('action')) { event.preventDefault(); return; }
  if (!form.email.value.trim() && !form.phone.value.trim()) {
    event.preventDefault();
    form.email.setCustomValidity('Enter an email address or phone number.');
    form.email.reportValidity();
    return;
  }
  document.getElementById('book-button').disabled = true;
  document.getElementById('book-button').textContent = 'Saving your appointment...';
});
['email', 'phone'].forEach(name => document.querySelector(`[name="${name}"]`)?.addEventListener('input', () => {
  document.querySelector('[name="email"]').setCustomValidity('');
}));
