# frozen_string_literal: true
class KundexaOperation < ApplicationRecord
  serialize :result, coder: JSON
end
