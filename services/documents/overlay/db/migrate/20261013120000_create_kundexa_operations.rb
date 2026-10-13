# frozen_string_literal: true
class CreateKundexaOperations < ActiveRecord::Migration[8.0]
  def change
    create_table :kundexa_operations do |t|
      t.bigint :account_id, null: false
      t.string :operation_key, null: false
      t.string :request_hash, null: false
      t.text :result
      t.timestamps
    end
    add_index :kundexa_operations, %i[account_id operation_key], unique: true
  end
end
